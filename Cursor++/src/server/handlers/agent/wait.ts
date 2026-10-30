import type { AgentServerMessage } from '../../gen/agent_v1_pb';
import { AGENT_HEARTBEAT_INTERVAL_MS } from './constants';
import { waitForInteractionResponse, waitForMessageMatching, type AgentSession } from './session';
import { heartbeat } from './stream';

export class AgentRunAbortedError extends Error {
    readonly execMessageId?: number;
    readonly clientStackTrace?: string;

    constructor(message: string, opts?: { execMessageId?: number; clientStackTrace?: string }) {
        super(message);
        this.name = 'AgentRunAbortedError';
        this.execMessageId = opts?.execMessageId;
        this.clientStackTrace = opts?.clientStackTrace;
    }
}

export function isAgentRunAbortedError(error: unknown): error is AgentRunAbortedError {
    return error instanceof AgentRunAbortedError;
}

export function isSessionCancellationError(session: AgentSession, error: unknown): error is AgentRunAbortedError {
    return session.cancelledReason !== undefined && isAgentRunAbortedError(error);
}

/**
 * 客户端已发 cancelAction 则抛出中断,把控制权交回 conversationRuntime /
 * agentOrchestrator 的 isAgentRunAbortedError 分支干净收尾。
 *
 * 放在每个可能长时间停留的位置调用: 工具等待返回后、LLM 流每个事件、
 * round 边界。中断粒度因此收敛到单个事件而非整轮。
 */
export function throwIfSessionCancelled(session: AgentSession): void {
    if (session.cancelledReason === undefined)
        return;
    throw new AgentRunAbortedError(`client cancelled the run: ${session.cancelledReason}`);
}

export function isExecClientMessageForId(msg: Record<string, unknown>, execMessageId: number): boolean {
    return 'execClientMessage' in msg
        && Number((msg.execClientMessage as Record<string, unknown>).id) === execMessageId;
}

export function isExecStreamCloseForId(msg: Record<string, unknown>, execMessageId: number): boolean {
    if (!('execClientControlMessage' in msg)) return false;
    const ctrl = msg.execClientControlMessage as Record<string, unknown>;
    const streamClose = ctrl.streamClose as Record<string, unknown> | undefined;
    return Number(streamClose?.id) === execMessageId;
}

function getExecThrowForId(msg: Record<string, unknown>, execMessageId: number): Record<string, unknown> | null {
    if (!('execClientControlMessage' in msg)) return null;
    const ctrl = msg.execClientControlMessage as Record<string, unknown>;
    const thrown = ctrl.throw as Record<string, unknown> | undefined;
    if (!thrown) return null;
    return Number(thrown.id) === execMessageId ? thrown : null;
}

function buildExecAbortError(execThrow: Record<string, unknown>, execMessageId: number): AgentRunAbortedError {
    const error = typeof execThrow.error === 'string' && execThrow.error.trim().length > 0
        ? execThrow.error
        : 'exec client aborted the current run';
    const clientStackTrace = typeof execThrow.stackTrace === 'string' ? execThrow.stackTrace : undefined;
    return new AgentRunAbortedError(error, { execMessageId, clientStackTrace });
}

export async function waitForExecMessageMatching(
    session: AgentSession,
    execMessageId: number,
    predicate: (msg: Record<string, unknown>) => boolean,
    timeoutMs: number | null,
): Promise<Record<string, unknown> | null> {
    const msg = await waitForMessageMatching(
        session,
        (candidate) => predicate(candidate) || !!getExecThrowForId(candidate, execMessageId),
        timeoutMs,
    );
    // 客户端中断 (cancelAction) 会让 waitForMessageMatching 立即返回 null。
    // 转成 AgentRunAbortedError,与 exec throw 走同一条干净收尾路径 ——
    // 否则工具会拿着 null 结果继续往下跑。
    throwIfSessionCancelled(session);
    if (!msg) return null;

    const execThrow = getExecThrowForId(msg, execMessageId);
    if (execThrow) {
        throw buildExecAbortError(execThrow, execMessageId);
    }
    return msg;
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 在等待 Promise 期间持续 yield heartbeat，防止 Cursor stall detector 误判连接断开。
 *
 * 返回值通过 async generator 的 return value 传递，便于调用方使用 `yield*` 获取结果：
 *   const response = yield* waitForPromiseWithHeartbeat(promise)
 */
export async function* waitForPromiseWithHeartbeat<T>(
    promise: Promise<T>,
    intervalMs = AGENT_HEARTBEAT_INTERVAL_MS,
): AsyncGenerator<AgentServerMessage, T, void> {
    let settled = false;
    let result: T;
    let failure: unknown;

    const wrapped = promise.then(
        (value) => {
            settled = true;
            result = value;
        },
        (error) => {
            settled = true;
            failure = error;
        },
    );

    while (!settled) {
        const raced = await Promise.race([
            wrapped.then(() => 'done' as const),
            delay(intervalMs).then(() => 'tick' as const),
        ]);
        if (raced === 'tick' && !settled) {
            yield heartbeat();
        }
    }

    if (failure !== undefined) throw failure;
    return result!;
}

export async function* waitForMessageMatchingWithHeartbeat(
    session: AgentSession,
    predicate: (msg: Record<string, unknown>) => boolean,
    timeoutMs: number | null = null,
    intervalMs = AGENT_HEARTBEAT_INTERVAL_MS,
): AsyncGenerator<AgentServerMessage, Record<string, unknown> | null, void> {
    return yield* waitForPromiseWithHeartbeat(
        waitForMessageMatching(session, predicate, timeoutMs),
        intervalMs,
    );
}

export async function* waitForInteractionResponseWithHeartbeat(
    session: AgentSession,
    id: number,
    expectedCase: string,
    timeoutMs: number | null = null,
    intervalMs = AGENT_HEARTBEAT_INTERVAL_MS,
): AsyncGenerator<AgentServerMessage, Record<string, unknown> | null, void> {
    return yield* waitForPromiseWithHeartbeat(
        waitForInteractionResponse(session, id, expectedCase, timeoutMs),
        intervalMs,
    );
}

export async function* waitForExecClientMessageWithHeartbeat(
    session: AgentSession,
    execMessageId: number,
    timeoutMs: number | null = null,
    intervalMs = AGENT_HEARTBEAT_INTERVAL_MS,
): AsyncGenerator<AgentServerMessage, Record<string, unknown> | null, void> {
    return yield* waitForPromiseWithHeartbeat(
        waitForExecMessageMatching(
            session,
            execMessageId,
            (msg) => isExecClientMessageForId(msg, execMessageId),
            timeoutMs,
        ),
        intervalMs,
    );
}

export async function* waitForExecStreamCloseWithHeartbeat(
    session: AgentSession,
    execMessageId: number,
    timeoutMs: number | null = null,
    intervalMs = AGENT_HEARTBEAT_INTERVAL_MS,
): AsyncGenerator<AgentServerMessage, Record<string, unknown> | null, void> {
    return yield* waitForPromiseWithHeartbeat(
        waitForExecMessageMatching(
            session,
            execMessageId,
            (msg) => isExecStreamCloseForId(msg, execMessageId),
            timeoutMs,
        ),
        intervalMs,
    );
}

/** 等待 exec result + stream close（Promise 形式，用于 Promise.all 并发） */
export async function awaitExecResultAndClose(
    session: AgentSession,
    execMessageId: number,
    timeoutMs: number | null = null,
): Promise<Record<string, unknown> | null> {
    const execResult = await waitForExecMessageMatching(
        session,
        execMessageId,
        msg => isExecClientMessageForId(msg, execMessageId),
        timeoutMs,
    );
    await waitForExecMessageMatching(
        session,
        execMessageId,
        msg => isExecStreamCloseForId(msg, execMessageId),
        5_000,
    ).catch(() => {});
    return execResult;
}

export async function* waitForShellExecEventWithHeartbeat(
    session: AgentSession,
    execMessageId: number,
    timeoutMs: number | null = null,
    intervalMs = AGENT_HEARTBEAT_INTERVAL_MS,
): AsyncGenerator<AgentServerMessage, Record<string, unknown> | null, void> {
    return yield* waitForPromiseWithHeartbeat(
        waitForExecMessageMatching(
            session,
            execMessageId,
            (msg) => isExecClientMessageForId(msg, execMessageId) || isExecStreamCloseForId(msg, execMessageId),
            timeoutMs,
        ),
        intervalMs,
    );
}
