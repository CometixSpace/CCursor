import type { AgentServerMessage } from '../../gen/agent_v1_pb';
import { logger } from '../../logger';
import type { ProviderRoundContext } from '../llm/providerRuntime';
import type { LLMContentBlock, LLMMessage } from '../llm/types';
import {
    buildExecToolResult,
    buildShellToolResult,
    type ToolResultEnvelope,
} from './toolResults';
import { finalizeToolCall } from './toolLifecycle';
import { shellToolCallStderrDelta, shellToolCallStdoutDelta } from './stream';
import { registerBackgroundJob, type AgentSession } from './session';
import type { ReadContextState } from './contextCatalog';
import {
    waitForExecClientMessageWithHeartbeat,
    waitForExecStreamCloseWithHeartbeat,
    waitForShellExecEventWithHeartbeat,
} from './wait';

/**
 * 归一化 ShellBackgroundReason(toJson 后可能是 enum 字符串名或数字)。
 * 0=UNSPECIFIED, 1=TIMEOUT, 2=USER_REQUEST (gen: agent.v1.ShellBackgroundReason)。
 */
function normalizeShellBackgroundReason(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string') return undefined;
    switch (value.trim()) {
        case 'SHELL_BACKGROUND_REASON_UNSPECIFIED':
        case 'UNSPECIFIED':
            return 0;
        case 'SHELL_BACKGROUND_REASON_TIMEOUT':
        case 'TIMEOUT':
            return 1;
        case 'SHELL_BACKGROUND_REASON_USER_REQUEST':
        case 'USER_REQUEST':
            return 2;
        default: {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : undefined;
        }
    }
}

export async function* finalizeExecTool(params: {
    session: AgentSession;
    toolName: string;
    callId: string;
    cursorToolType: string;
    execMessageId: number;
    modelCallId: string;
    startedArgs: Record<string, unknown>;
    input: Record<string, unknown>;
    roundContext: Pick<ProviderRoundContext, 'createToolResult' | 'recordToolResult'>;
    messages: LLMMessage[];
    imageCollector?: LLMContentBlock[];
    readContext?: ReadContextState;
    /** Task 报告入口截断上下文 — 仅 taskToolCall 路径传入 */
    entryTruncation?: import('./toolkit/results/taskToolResults').TaskEntryTruncationContext;
}): AsyncGenerator<AgentServerMessage, AgentServerMessage, void> {
    let toolResult: ToolResultEnvelope = { result: { case: 'error', value: { message: 'no result' } } };
    let completedFrame: AgentServerMessage | null = null;

    if (params.cursorToolType === 'shellToolCall') {
        let stdout = '';
        let stderr = '';
        let exitCode = 0;
        let cwd = '';
        let localExecTime = 0;
        let rejected: { reason?: string } | undefined;
        let permissionDenied: { command?: string; workingDirectory?: string; error?: string } | undefined;
        let backgrounded: { shellId: number; pid?: number; msToWait?: number; reason?: number; terminalsFolder?: string } | undefined;
        let done = false;

        const processShellMessage = function* (shellMsg: Record<string, unknown>): Generator<AgentServerMessage, void, void> {
            if ('execClientMessage' in shellMsg) {
                const ecm = shellMsg.execClientMessage as Record<string, unknown>;
                const ss = ecm.shellStream as Record<string, unknown> | undefined;
                if (ss?.stdout) {
                    const chunk = String((ss.stdout as Record<string, unknown>).data ?? '');
                    stdout += chunk;
                    if (chunk) yield shellToolCallStdoutDelta(params.callId, chunk, params.modelCallId);
                }
                if (ss?.stderr) {
                    const chunk = String((ss.stderr as Record<string, unknown>).data ?? '');
                    stderr += chunk;
                    if (chunk) yield shellToolCallStderrDelta(params.callId, chunk, params.modelCallId);
                }
                if (ss?.permissionDenied) {
                    const denied = ss.permissionDenied as Record<string, unknown>;
                    permissionDenied = {
                        command: typeof denied.command === 'string' ? denied.command : undefined,
                        workingDirectory: typeof denied.workingDirectory === 'string' ? denied.workingDirectory : undefined,
                        error: typeof denied.error === 'string' ? denied.error : undefined,
                    };
                    done = true;
                }
                if (ss?.rejected) {
                    const rejectedPayload = ss.rejected as Record<string, unknown>;
                    rejected = { reason: typeof rejectedPayload.reason === 'string' ? rejectedPayload.reason : undefined };
                    done = true;
                }
                if (ss?.backgrounded) {
                    // 命令转后台 (ShellStreamBackgrounded)。执行侧主导转后台,server 是接收方:
                    // 提取 shellId/pid/msToWait/reason, 登记后台 job 供后续 AwaitShell 分流,
                    // 并据此构造"已转后台"结果(而非误把片段输出当 exitCode=0 成功)。
                    const bg = ss.backgrounded as Record<string, unknown>;
                    const shellId = typeof bg.shellId === 'number' ? bg.shellId : Number(bg.shellId);
                    const pid = typeof bg.pid === 'number' ? bg.pid : undefined;
                    const msToWait = typeof bg.msToWait === 'number' ? bg.msToWait : undefined;
                    const reason = normalizeShellBackgroundReason(bg.reason);
                    const terminalsFolder = params.session.terminalsFolder;
                    backgrounded = {
                        shellId,
                        ...(pid !== undefined ? { pid } : {}),
                        ...(msToWait !== undefined ? { msToWait } : {}),
                        ...(reason !== undefined ? { reason } : {}),
                        ...(terminalsFolder ? { terminalsFolder } : {}),
                    };
                    if (Number.isFinite(shellId)) {
                        registerBackgroundJob(params.session, String(shellId), {
                            kind: 'shell',
                            shellId,
                            terminalsFolder,
                            command: typeof bg.command === 'string' ? bg.command : (typeof params.input.command === 'string' ? params.input.command : undefined),
                        });
                    }
                    logger.info({ tool: params.toolName, callId: params.callId, shellId, reason, msToWait }, '[TOOL] shell moved to background');
                    done = true;
                }
                if (ss?.exit) {
                    const exit = ss.exit as Record<string, unknown>;
                    cwd = typeof exit.cwd === 'string' ? exit.cwd : '';
                    localExecTime = typeof exit.localExecutionTimeMs === 'number' ? exit.localExecutionTimeMs : 0;
                    exitCode = typeof exit.code === 'number' ? (exit.code | 0) : 0;
                    done = true;
                }
            }
            if ('execClientControlMessage' in shellMsg) {
                const ctrl = shellMsg.execClientControlMessage as Record<string, unknown>;
                if (ctrl.streamClose) done = true;
            }
        };

        logger.info({ tool: params.toolName, callId: params.callId }, '[TOOL] waiting for shell approval/execution start');
        const firstShellMsg = yield* waitForShellExecEventWithHeartbeat(params.session, params.execMessageId, null);
        if (firstShellMsg) {
            yield* processShellMessage(firstShellMsg);
        } else {
            done = true;
        }

        while (!done) {
            const shellMsg = yield* waitForShellExecEventWithHeartbeat(params.session, params.execMessageId, null);
            if (!shellMsg) {
                done = true;
                break;
            }
            yield* processShellMessage(shellMsg);
        }

        const finalized = finalizeToolCall({
            roundContext: params.roundContext,
            messages: params.messages,
                        cursorToolType: params.cursorToolType,
            toolName: params.toolName,
            callId: params.callId,
            startedArgs: params.startedArgs,
            rawToolResult: buildShellToolResult(params.input, {
                stdout,
                stderr,
                exitCode,
                cwd,
                localExecutionTimeMs: localExecTime,
                rejected,
                permissionDenied,
                backgrounded,
            }),
            input: params.input,
            modelCallId: params.modelCallId,
        });
        toolResult = finalized.toolResult;
        completedFrame = finalized.frame;
        if (finalized.imageBlock && params.imageCollector)
            params.imageCollector.push(finalized.imageBlock);
        logger.info({
            tool: params.toolName,
            stdoutLen: stdout.length,
            stderrLen: stderr.length,
            exitCode,
            execTime: localExecTime,
        }, '[TOOL] shell exec completed');
    } else {
        const execResult = yield* waitForExecClientMessageWithHeartbeat(
            params.session,
            params.execMessageId,
            null,
        );
        if (execResult && 'execClientMessage' in execResult) {
            const ecm = execResult.execClientMessage as Record<string, unknown>;
            const finalized = finalizeToolCall({
                roundContext: params.roundContext,
                messages: params.messages,
                                cursorToolType: params.cursorToolType,
                toolName: params.toolName,
                callId: params.callId,
                startedArgs: params.startedArgs,
                rawToolResult: buildExecToolResult(params.cursorToolType, ecm, params.input),
                input: params.input,
                modelCallId: params.modelCallId,
                readContext: params.readContext,
                entryTruncation: params.entryTruncation,
            });
            toolResult = finalized.toolResult;
            completedFrame = finalized.frame;
            if (finalized.imageBlock && params.imageCollector)
                params.imageCollector.push(finalized.imageBlock);
            logger.info({ tool: params.toolName }, '[TOOL] exec result received');
        } else {
            logger.warn({ tool: params.toolName }, '[TOOL] exec ended without result');
        }

        yield* waitForExecStreamCloseWithHeartbeat(
            params.session,
            params.execMessageId,
            null,
        );
    }

    if (!completedFrame) {
        const finalized = finalizeToolCall({
            roundContext: params.roundContext,
            messages: params.messages,
                        cursorToolType: params.cursorToolType,
            toolName: params.toolName,
            callId: params.callId,
            startedArgs: params.startedArgs,
            rawToolResult: toolResult,
            input: params.input,
            modelCallId: params.modelCallId,
        });
        completedFrame = finalized.frame;
    }

    yield completedFrame;
    return completedFrame;
}
