import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getConversationSpillDir } from '../../../../config/paths';
import { TASK_ENTRY_CAP_RATIO } from '../../constants';
import { countTokens, sliceTextHeadTailTokens } from '../../tokenCounter';
import {
    arr,
    bigintLike,
    bool,
    envelope,
    obj,
    str,
    type ToolResultEnvelope,
} from './shared';

/**
 * Task 报告入口截断上下文 — 由 run 循环从调用点传入。
 *
 * 缺失时 (管线不可达的旁路) 按固定 25K tok 处理 (258K 窗的 ENTRY_CAP 平价)。
 */
export interface TaskEntryTruncationContext {
    conversationId: string;
    contextTokenLimit?: number;
    toolCallId: string;
}

/** ENTRY_CAP = min(25K tok, 25% × 窗口)。窗口不可知时按 100K 计 → 固定 25K。 */
export const TASK_ENTRY_CAP_MAX_TOKENS = 25_000;
const TASK_ENTRY_CAP_DEFAULT_WINDOW_TOKENS = 100_000;

export function resolveTaskEntryCapTokens(contextTokenLimit?: number): number {
    const window = contextTokenLimit !== undefined && contextTokenLimit > 0
        ? contextTokenLimit
        : TASK_ENTRY_CAP_DEFAULT_WINDOW_TOKENS;
    return Math.min(TASK_ENTRY_CAP_MAX_TOKENS, Math.floor(TASK_ENTRY_CAP_RATIO * window));
}

/** toolCallId → 文件名安全形式 (call id 可能含 ':' 等 shell 不友好字符)。 */
function toSpillFileName(toolCallId: string): string {
    const safe = toolCallId.replace(/[^\w.-]+/g, '_');
    return `${safe || 'task-call'}.txt`;
}

/**
 * 截断前全文落盘 (spill)。写失败不阻塞主流程 — 返回 null,
 * 调用方把截断标注降级为无路径版 (设计文档: 违反约束 6 比入口截断本身更糟,
 * 故 spill 尽力而为, 失败时仍截断并声明原文未保存)。
 */
function spillTaskReportToFile(conversationId: string, toolCallId: string, fullText: string): string | null {
    try {
        const dir = getConversationSpillDir(conversationId);
        mkdirSync(dir, { recursive: true });
        const filePath = join(dir, toSpillFileName(toolCallId));
        writeFileSync(filePath, fullText, 'utf8');
        return filePath;
    }
    catch {
        return null;
    }
}

/**
 * 入口截断: o200k 实测超 ENTRY_CAP → 头 70% + 尾 30% (token 预算),
 * 截断标注含原始 token 数与 spill 文件路径 (可恢复性)。
 */
function truncateTaskReportForEntry(body: string, transcriptPath: string, entryContext?: TaskEntryTruncationContext): string {
    const entryCapTokens = resolveTaskEntryCapTokens(entryContext?.contextTokenLimit);
    const originalTokens = countTokens(body);
    if (originalTokens <= entryCapTokens)
        return body;

    const headTokens = Math.floor(entryCapTokens * 0.7);
    const tailTokens = Math.max(0, entryCapTokens - headTokens);
    const { head, tail } = sliceTextHeadTailTokens(body, headTokens, tailTokens);

    let spillPath: string | null = null;
    if (entryContext?.conversationId)
        spillPath = spillTaskReportToFile(entryContext.conversationId, entryContext.toolCallId, body);

    const recoveryHints: string[] = [];
    if (transcriptPath)
        recoveryHints.push(`re-run Task or read the subagent transcript at ${transcriptPath}`);
    if (spillPath)
        recoveryHints.push(`full report saved to ${spillPath}`);
    if (recoveryHints.length === 0)
        recoveryHints.push('re-run the Task tool to regenerate the report (full text could not be saved)');

    return [
        `[Task report truncated at entry: original ${originalTokens} tokens exceeded cap ${entryCapTokens} tokens; head 70% + tail 30% retained]`,
        `[To recover: ${recoveryHints.join('; ')}]`,
        '--- head ---',
        head,
        '--- [middle elided] ---',
        '--- tail ---',
        tail,
    ].filter(part => part !== '').join('\n');
}

function normalizeConversationStep(value: unknown): Record<string, unknown> {
    const step = obj(value);
    const message = obj(step.message);
    if (typeof message.case === 'string') return { message };
    if (step.assistantMessage) {
        return { message: { case: 'assistantMessage', value: obj(step.assistantMessage) } };
    }
    if (step.toolCall) {
        return { message: { case: 'toolCall', value: obj(step.toolCall) } };
    }
    if (step.thinkingMessage) {
        return { message: { case: 'thinkingMessage', value: obj(step.thinkingMessage) } };
    }
    return { message: { case: 'assistantMessage', value: { text: '' } } };
}

function extractConversationStepText(value: unknown): string {
    const step = obj(value);

    // Normalized protobuf oneof shape used by our ToolResultEnvelope:
    //   { message: { case: 'assistantMessage', value: { text } } }
    const message = obj(step.message);
    if (message.case === 'assistantMessage') return str(obj(message.value).text);

    // protobuf JSON / Cursor client expanded shape:
    //   { assistantMessage: { text } }
    if (step.assistantMessage) return str(obj(step.assistantMessage).text);

    return '';
}

function optionalNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    if (typeof value === 'bigint') {
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) ? parsed : undefined;
    }
    return undefined;
}

function optionalSubagentBackgroundReason(value: unknown): number | undefined {
    const numeric = optionalNumber(value);
    if (numeric !== undefined) return numeric;
    if (typeof value !== 'string') return undefined;

    switch (value.trim()) {
        case 'SUBAGENT_BACKGROUND_REASON_UNSPECIFIED':
        case 'UNSPECIFIED':
            return 0;
        case 'SUBAGENT_BACKGROUND_REASON_AGENT_REQUEST':
        case 'AGENT_REQUEST':
            return 1;
        case 'SUBAGENT_BACKGROUND_REASON_USER_REQUEST':
        case 'USER_REQUEST':
            return 2;
        case 'SUBAGENT_BACKGROUND_REASON_QUEUED_FOLLOW_UP':
        case 'QUEUED_FOLLOW_UP':
            return 3;
        default:
            return undefined;
    }
}

/** SubagentBackgroundReason 数值 → 可读名 (gen: agent.v1.SubagentBackgroundReason)。 */
function subagentBackgroundReasonName(reason: number): string {
    switch (reason) {
        case 1: return 'AGENT_REQUEST';
        case 2: return 'USER_REQUEST';
        case 3: return 'QUEUED_FOLLOW_UP';
        default: return 'UNSPECIFIED';
    }
}

export function buildTaskExecToolResult(execClientMsg: Record<string, unknown>): ToolResultEnvelope | null {
    const sr = obj(execClientMsg.subagentResult);
    const success = obj(sr.success);
    if (sr.success) {
        const finalMessage = str(success.finalMessage);
        const durationMs = bigintLike(success.durationMs);
        const backgroundReason = optionalSubagentBackgroundReason(success.backgroundReason);
        const toolCallCount = optionalNumber(success.toolCallCount);
        // SubagentSuccess (gen: agent.v1.SubagentSuccess) 无 isBackground 字段,
        // 只有 background_reason(4)。原 bool(success.isBackground) 恒 false 是死代码。
        // isBackground 应由 backgroundReason != 0 推导 —— 这才是"是否转后台"的原始语义。
        const isBackground = backgroundReason !== undefined && backgroundReason !== 0;
        return {
            result: {
                case: 'success',
                value: {
                    conversationSteps: finalMessage
                        ? [{ message: { case: 'assistantMessage', value: { text: finalMessage } } }]
                        : [],
                    ...(typeof success.agentId === 'string' ? { agentId: success.agentId } : {}),
                    isBackground,
                    ...(durationMs !== undefined ? { durationMs } : {}),
                    ...(typeof success.resultSuffix === 'string' ? { resultSuffix: success.resultSuffix } : {}),
                    ...(backgroundReason !== undefined ? { backgroundReason } : {}),
                    ...(typeof success.transcriptPath === 'string' ? { transcriptPath: success.transcriptPath } : {}),
                    ...(toolCallCount !== undefined ? { toolCallCount } : {}),
                },
            },
        };
    }
    const error = obj(sr.error);
    if (sr.error) {
        return {
            result: {
                case: 'error',
                value: {
                    error: str(error.error, 'subagent error'),
                    ...(typeof error.agentId === 'string' ? { agentId: error.agentId } : {}),
                },
            },
        };
    }
    return { result: { case: 'error', value: { error: 'no result' } } };
}

export function normalizeTaskToolResult(resultCaseName: string, value: Record<string, unknown>): ToolResultEnvelope | null {
    if (resultCaseName === 'success') {
        const backgroundReason = optionalSubagentBackgroundReason(value.backgroundReason);
        const toolCallCount = optionalNumber(value.toolCallCount);
        // isBackground 同 buildTaskExecToolResult: 由 backgroundReason 推导,
        // 同时兼容已经显式带了 isBackground 的归一化输入(取或值)。
        const isBackground = bool(value.isBackground) || (backgroundReason !== undefined && backgroundReason !== 0);
        return envelope('success', {
            conversationSteps: arr(value.conversationSteps).map(normalizeConversationStep),
            ...(typeof value.agentId === 'string' ? { agentId: value.agentId } : {}),
            isBackground,
            ...(value.durationMs !== undefined ? { durationMs: value.durationMs } : {}),
            ...(typeof value.resultSuffix === 'string' ? { resultSuffix: value.resultSuffix } : {}),
            ...(backgroundReason !== undefined ? { backgroundReason } : {}),
            ...(typeof value.transcriptPath === 'string' ? { transcriptPath: value.transcriptPath } : {}),
            ...(toolCallCount !== undefined ? { toolCallCount } : {}),
        });
    }
    if (resultCaseName) return envelope(resultCaseName, value);
    return null;
}

export function buildTaskToolResultText(
    resultCaseName: string,
    value: Record<string, unknown>,
    entryContext?: TaskEntryTruncationContext,
): string | null {
    if (resultCaseName === 'success') {
        const texts = arr<Record<string, unknown>>(value.conversationSteps)
            .map(extractConversationStepText)
            .filter(Boolean);

        const parts = texts.length > 0 ? [...texts] : [];
        const resultSuffix = str(value.resultSuffix).trim();
        const transcriptPath = str(value.transcriptPath).trim();
        if (resultSuffix) parts.push(resultSuffix);
        if (transcriptPath) parts.push(`[Subagent transcript: ${transcriptPath}]`);

        // backgroundReason != 0 → subagent 已转后台,而非真正完成。必须明确告诉 LLM 去轮询,
        // 否则会被误读成 "Subagent completed"。agentId 即 AwaitShell 的 task_id。
        const backgroundReason = optionalSubagentBackgroundReason(value.backgroundReason);
        if (backgroundReason !== undefined && backgroundReason !== 0) {
            const agentId = typeof value.agentId === 'string' ? value.agentId : '';
            const pollingInstruction = agentId
                ? `Use AwaitShell with task_id="${agentId}" to poll for completion.`
                : 'Use AwaitShell with the agent id to poll for completion.';
            parts.push(
                `[Task moved to background: ${subagentBackgroundReasonName(backgroundReason)}. ${pollingInstruction}]`,
            );
        }

        const body = parts.join('\n\n').trim();
        if (body)
            return truncateTaskReportForEntry(body, transcriptPath, entryContext);
        return `Subagent completed${typeof value.agentId === 'string' ? `: ${value.agentId}` : ''}`;
    }
    if (resultCaseName) return `Task ${resultCaseName || 'error'}: ${JSON.stringify(value)}`;
    return null;
}
