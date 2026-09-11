import type { AgentServerMessage } from '../../gen/agent_v1_pb';
import { withProviderRequestLifecycle } from '../llm/requestLifecycle';
import { AGENT_HEARTBEAT_INTERVAL_MS } from './constants';
import { waitForInteractionResponse, waitForMessageMatching, type AgentSession } from './session';
import { heartbeat } from './stream';

export const HEARTBEAT_TICK: unique symbol = Symbol('summary-heartbeat-tick');

/** Keep silent provider streams alive without requesting a second pending next(). */
export function pumpWithTimedHeartbeats<TEvent>(
    source: AsyncIterable<TEvent> | ((signal: AbortSignal) => AsyncIterable<TEvent>),
    heartbeatIntervalMs: number = AGENT_HEARTBEAT_INTERVAL_MS,
    signal?: AbortSignal,
): AsyncGenerator<TEvent | typeof HEARTBEAT_TICK, void, unknown> {
    return withProviderRequestLifecycle(lifecycle => pumpHeartbeatEvents(
        typeof source === 'function' ? source(lifecycle.signal) : source,
        heartbeatIntervalMs,
    ), signal);
}

async function* pumpHeartbeatEvents<TEvent>(
    sourceStream: AsyncIterable<TEvent>,
    heartbeatIntervalMs: number,
): AsyncGenerator<TEvent | typeof HEARTBEAT_TICK, void, void> {
    const sourceIterator = sourceStream[Symbol.asyncIterator]();
    let pendingStep: Promise<IteratorResult<TEvent>> | null = null;
    try {
        while (true) {
            pendingStep = pendingStep ?? sourceIterator.next();
            let timerId: ReturnType<typeof setTimeout> | undefined;
            const tickPromise = new Promise<typeof HEARTBEAT_TICK>((resolveTick) => {
                timerId = setTimeout(() => resolveTick(HEARTBEAT_TICK), heartbeatIntervalMs);
            });
            let raceOutcome: IteratorResult<TEvent> | typeof HEARTBEAT_TICK;
            try {
                raceOutcome = await Promise.race([pendingStep, tickPromise]);
            }
            finally {
                clearTimeout(timerId);
            }
            if (raceOutcome === HEARTBEAT_TICK) {
                yield HEARTBEAT_TICK;
                continue;
            }
            pendingStep = null;
            if (raceOutcome.done)
                return;
            yield raceOutcome.value;
        }
    }
    finally {
        // The lifecycle aborts the request; return() can still wait behind next().
        void Promise.resolve().then(() => sourceIterator.return?.()).catch(() => {});
    }
}

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
    const completion = promise.then(
        (value) => {
            settled = true;
            return { kind: 'resolved' as const, value };
        },
        (error: unknown) => {
            settled = true;
            return { kind: 'rejected' as const, error };
        },
    );

    while (true) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let outcome: Awaited<typeof completion> | 'tick';
        try {
            outcome = await Promise.race([
                completion,
                new Promise<'tick'>(resolve => {
                    timer = setTimeout(() => resolve('tick'), intervalMs);
                }),
            ]);
        } finally {
            if (timer !== undefined)
                clearTimeout(timer);
        }
        if (outcome !== 'tick') {
            if (outcome.kind === 'rejected')
                throw outcome.error;
            return outcome.value;
        }
        if (!settled)
            yield heartbeat();
    }
}

export async function* waitForMessageMatchingWithHeartbeat(
    session: AgentSession,
    predicate: (msg: Record<string, unknown>) => boolean,
    timeoutMs: number | null = null,
    intervalMs = AGENT_HEARTBEAT_INTERVAL_MS,
    signal?: AbortSignal,
): AsyncGenerator<AgentServerMessage, Record<string, unknown> | null, void> {
    return yield* waitForPromiseWithHeartbeat(
        waitForMessageMatching(session, predicate, timeoutMs, signal),
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
