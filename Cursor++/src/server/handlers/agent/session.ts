/**
 * Agent Session 管理
 *
 * SSE 降级模式下，Client 通过两个独立通道通信:
 *   - BidiAppend (unary) — 发送 AgentClientMessage (hex data / dataBinary)
 *   - RunSSE (server_streaming) — 接收 AgentServerMessage 流
 *
 * 两者通过 requestId 关联。Session 维护一个 per-requestId 的消息队列，
 * BidiAppend 写入消息，RunSSE 消费消息并驱动 LLM 调用。
 */
import { fromBinary, toJson } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { createHash } from 'node:crypto';
import { type AgentServerMessage, AgentClientMessageSchema } from '../../gen/agent_v1_pb';
import { logger } from '../../logger';

interface PendingAppend {
    message: Record<string, unknown> | null;
    digest: string;
    byteLength: number;
}

interface AppendSequenceState {
    nextSequence: bigint;
    pending: Map<bigint, PendingAppend>;
    pendingBytes: number;
}

interface SessionQueueCharges {
    messages: WeakMap<Record<string, unknown>, number[]>;
    queuedBytes: number;
}

// Local safeguards, not official protocol limits. The official sender allows
// concurrent appends and retries, so arrival order is not input stream order.
export const MAX_LIVE_SSE_SESSIONS = 32;
export const MAX_TRANSPORT_QUEUED_BYTES = 64 * 1024 * 1024;
export const MAX_SESSION_QUEUED_MESSAGES = 1024;
export const MAX_PENDING_APPENDS = 1024;
export const SESSION_RETENTION_MS = 30_000;

let liveSseSessions = 0;
let retainedTransportBytes = 0;

/** Counted encoded payload, not JS heap or transport/library receive buffers. */
export function getTransportResourceUsage(): { liveSseSessions: number; queuedBytes: number } {
    return { liveSseSessions, queuedBytes: retainedTransportBytes };
}

/**
 * 后台 job 登记项。
 *
 * Shell 转后台(ShellStreamBackgrounded)与 Subagent 转后台(SubagentSuccess.backgroundReason)后,
 * LLM 会在后续轮次调用 AwaitShell(task_id=...) 轮询其状态。AwaitShell 需要据 task_id 区分:
 *   - shell  : 走 readArgs 通道, 读取 {terminalsFolder}/{shellId}.txt 终端文件
 *   - subagent: 走 subagentAwaitArgs 通道 (agentId)
 * 因此必须在转后台时按 task_id 登记 kind + 路由所需信息。
 *
 * 作用域选择: 后台 shell 的 AwaitShell 轮询发生在 **同一个 agent run** 的后续工具调用里,
 * 与转后台事件共享同一 requestId/session(handleConversationRun 单次调用贯穿全部 round)。
 * 故注册表挂在 session 上, 而非全局 Map。
 */
export interface BackgroundJob {
    kind: 'shell' | 'subagent';
    /** shell job: 执行侧回报的 shell_id (AwaitShell 的 task_id) */
    shellId?: number;
    /** subagent job: SubagentSuccess.agentId (AwaitShell 的 task_id) */
    agentId?: string;
    /** shell job: 终端输出文件所在目录 (env.terminalsFolder), 文件为 {terminalsFolder}/{shellId}.txt */
    terminalsFolder?: string;
    /** subagent job: transcript 文件路径 (SubagentSuccess.transcriptPath), 供日志/降级使用 */
    transcriptPath?: string;
    command?: string;
}

export interface AgentSession {
    requestId: string;
    messages: Array<Record<string, unknown>>;
    listeners: Set<() => void>;
    closed: boolean;
    /** The Run/RunSSE RPC signal, never the short-lived BidiAppend unary signal. */
    transportSignal?: AbortSignal;
    /** Allocating an id is not sending it. Only yielded Gets/Sets may be ACKed. */
    expectedBlobReplies?: Map<number, 'getBlobResult' | 'setBlobResult'>;
    transportError?: unknown;
    appendSequence?: AppendSequenceState;
    expirationTimer?: ReturnType<typeof setTimeout>;
    queueCharges?: SessionQueueCharges;
    /** Released once on cancel/close; tiny closed-ID tombstones do not count. */
    holdsSseAdmission?: boolean;
    /**
     * 后台 job 注册表 (key = task_id 字符串形式: shell 用 shellId, subagent 用 agentId)。
     * 转后台时登记, AwaitShell 据此分流 readArgs / subagentAwaitArgs。
     */
    backgroundJobs: Map<string, BackgroundJob>;
    /** KV ids remain monotonic when a transport session is reused by another run. */
    nextBlobRequestId?: number;
    /** Only correlation metadata, shared by runs using this transport session. */
    activeBlobRequestIds?: Set<number>;
    /** env.terminalsFolder — 用于构造后台 shell 的终端文件路径 {terminalsFolder}/{shellId}.txt */
    terminalsFolder?: string;
    /**
     * 客户端 cancelAction 携带的 reason;一经设置即表示本 run 已被客户端中断。
     *
     * 客户端中断当前生成 (点停止、提交新消息抢占、steer 降级后升级为 interrupt)
     * 时,ControlledConversationActionManager.abort() 会往同一条 BiDi 客户端流
     * 发 ConversationAction{cancelAction},随后才本地 abort。这是服务端唯一能
     * 感知"该停了"的信号 —— 不消费它,旧 run 会一直跑到 LLM 流自然结束,
     * 表现为"发新消息时前一条没有被终止"。
     *
     * 与 closed 的区别: closed 是传输层断开,cancelled 是应用层中断,
     * 后者到达时连接仍然活着(客户端还要用它接收后续帧)。
     */
    cancelledReason?: string;
}

export function createEphemeralSession(requestId: string): AgentSession {
    return {
        requestId,
        messages: [],
        listeners: new Set(),
        closed: false,
        backgroundJobs: new Map(),
        nextBlobRequestId: 900_000,
        activeBlobRequestIds: new Set(),
    };
}

/**
 * 判定一条 AgentClientMessage 是否为 steer 的运行中上下文注入。
 *
 * injectContextAction 与 userMessageAction / cancelAction 平级挂在
 * ConversationAction 上,走同一条 BiDi 客户端流发来。
 */
function isContextInjection(json: Record<string, unknown>): boolean {
    const action = json.conversationAction as Record<string, unknown> | undefined;
    return action !== undefined && 'injectContextAction' in action;
}

/**
 * 判定一条 AgentClientMessage 是否为客户端中断信号,并取出 reason。
 *
 * 判据是 cancelAction 存不存在,不是 reason 有没有值 —— proto3 里空字符串
 * 与缺省不可区分,而客户端确实可能发不带 reason 的中断。
 *
 * 实测 reason (3.17.19):
 *   "new_message_submitted"    submitChatMaybeAbortCurrent,提交新消息抢占当前生成
 *   "user_stopped_generation"  用户点停止按钮
 */
function extractCancelReason(json: Record<string, unknown>): string | undefined {
    const action = json.conversationAction as Record<string, unknown> | undefined;
    if (!action || !('cancelAction' in action))
        return undefined;
    const cancel = action.cancelAction as Record<string, unknown> | undefined;
    const reason = cancel?.reason;
    return typeof reason === 'string' && reason ? reason : 'cancelled';
}

/**
 * 消息入队的统一入口。两条上行通道 (bidi 的 pushSessionMessage、SSE 降级的
 * appendMessage) 都经过这里,保证不论客户端走哪条路都是同一套处理。
 *
 * 三类去向:
 *   injectContextAction — 丢弃 (见下)
 *   cancelAction        — 记为中断信号
 *   其余                — 进 messages 供 waitForMessageMatching 消费
 *
 * 丢弃注入的理由: 我们不支持运行中注入,而客户端对"服务端没有应答"本就有兜底 ——
 * run 结束时 reconcileSteerItemsWhenIdle 会撤掉乐观气泡、把消息退回队列,
 * 随后 tryDispatchNextQueueItem 自动发出,消息不会丢。但它没有任何
 * waitForMessageMatching 的 predicate 会匹配,留在 messages 里只会无限堆积。
 */
function ingestSessionMessage(session: AgentSession, json: Record<string, unknown>, encodedByteLength?: number): void {
    if (session.closed || session.cancelledReason !== undefined || 'clientHeartbeat' in json)
        return;
    const envelope = json.kvClientMessage as Record<string, unknown> | undefined;
    const blobRequestId = envelope?.id;
    if (envelope && typeof envelope === 'object' && ('getBlobResult' in envelope || 'setBlobResult' in envelope)
        && typeof blobRequestId === 'number' && Number.isInteger(blobRequestId)
        && blobRequestId >= 900_000 && blobRequestId < (session.nextBlobRequestId ?? 900_000)
        && !session.activeBlobRequestIds?.has(blobRequestId)) {
        // A completed request cannot become live again. Discard late bytes before
        // queueing them, without inspecting or decoding their potentially large body.
        return;
    }
    if ((session.transportSignal || session.appendSequence) && isUnsolicitedBlobReply(session, json))
        return;
    if (typeof blobRequestId === 'number' && envelope && ('getBlobResult' in envelope || 'setBlobResult' in envelope))
        session.expectedBlobReplies?.delete(blobRequestId);
    if (isContextInjection(json)) {
        logger.debug({ requestId: session.requestId }, '[SESSION] dropping context injection (run-time injection unsupported)');
        return;
    }
    const cancelReason = extractCancelReason(json);
    if (cancelReason !== undefined) {
        // 只认第一次 —— 客户端可能重复发,reason 以最先到达的为准
        if (session.cancelledReason === undefined) {
            session.cancelledReason = cancelReason;
            logger.info({ requestId: session.requestId, reason: cancelReason }, '[CANCEL] client cancelled the run');
        }
        releaseSessionPayloads(session);
        releaseSseAdmission(session);
    }
    else {
        if (session.messages.length >= MAX_SESSION_QUEUED_MESSAGES)
            rejectSessionResource(session, 'Agent session ordinary message queue exceeded its limit');
        // Production transports supply protobuf byte length. Direct in-process
        // callers may use non-proto JSON; count its serialized UTF-8 payload.
        const byteLength = encodedByteLength ?? Buffer.byteLength(JSON.stringify(json), 'utf8');
        chargeTransportBytes(session, byteLength);
        const charges = session.queueCharges ??= { messages: new WeakMap(), queuedBytes: 0 };
        const messageCharges = charges.messages.get(json) ?? [];
        messageCharges.push(byteLength);
        charges.messages.set(json, messageCharges);
        charges.queuedBytes += byteLength;
        session.messages.push(json);
    }
    notifyAll(session);
}

/** 客户端是否已中断本 run。 */
export function isSessionCancelled(session: AgentSession): boolean {
    return session.cancelledReason !== undefined;
}

/** 登记一个后台 job, 供后续 AwaitShell 分流。key = task_id 字符串形式。 */
export function registerBackgroundJob(session: AgentSession, taskId: string, job: BackgroundJob): void {
    session.backgroundJobs.set(taskId, job);
    logger.info({ requestId: session.requestId, taskId, kind: job.kind }, '[SESSION] background job registered');
}

/** 按 task_id 查找已登记的后台 job。 */
export function getBackgroundJob(session: AgentSession, taskId: string): BackgroundJob | undefined {
    return session.backgroundJobs.get(taskId);
}

function notifyAll(session: AgentSession): void {
    for (const fn of session.listeners) fn();
}

export function pushSessionMessage(session: AgentSession, json: Record<string, unknown>, encodedByteLength?: number): void {
    ingestSessionMessage(session, json, encodedByteLength);
}

function rejectSession(session: AgentSession, error: ConnectError): never {
    session.transportError = error;
    markSessionClosed(session);
    throw error;
}

function rejectSessionResource(session: AgentSession, detail: string): never {
    return rejectSession(session, new ConnectError(detail, Code.ResourceExhausted));
}

function chargeTransportBytes(session: AgentSession, byteLength: number): void {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0)
        rejectSessionResource(session, 'Agent transport received an invalid encoded payload size');
    if (byteLength > MAX_TRANSPORT_QUEUED_BYTES - retainedTransportBytes)
        rejectSessionResource(session, 'Agent transport process queued payload budget exceeded');
    retainedTransportBytes += byteLength;
}

function releaseMessageCharge(session: AgentSession, message: Record<string, unknown>): void {
    const charges = session.queueCharges;
    const messageCharges = charges?.messages.get(message);
    const byteLength = messageCharges?.shift();
    // Tests and legacy in-process callers can insert uncharged messages directly.
    if (byteLength === undefined || !charges)
        return;
    charges.queuedBytes -= byteLength;
    retainedTransportBytes -= byteLength;
    if (messageCharges?.length === 0)
        charges.messages.delete(message);
}

/** Discard matching ordinary messages in FIFO order, releasing only our charges. */
export function discardSessionMessages(session: AgentSession, predicate: (message: Record<string, unknown>) => boolean): void {
    session.messages = session.messages.filter(message => {
        if (!predicate(message))
            return true;
        releaseMessageCharge(session, message);
        return false;
    });
}

function takeSessionMessage(session: AgentSession, index: number): Record<string, unknown> {
    const message = session.messages.splice(index, 1)[0]!;
    releaseMessageCharge(session, message);
    return message;
}

function releaseSessionPayloads(session: AgentSession): void {
    // Release aggregate charges even if a direct caller replaced the array.
    retainedTransportBytes -= session.queueCharges?.queuedBytes ?? 0;
    session.queueCharges = undefined;
    session.messages.length = 0;
    session.expectedBlobReplies?.clear();
    if (session.appendSequence) {
        retainedTransportBytes -= session.appendSequence.pendingBytes;
        session.appendSequence.pending.clear();
        session.appendSequence.pendingBytes = 0;
    }
}

function releaseSseAdmission(session: AgentSession): void {
    if (session.holdsSseAdmission) {
        session.holdsSseAdmission = false;
        liveSseSessions--;
    }
}

export function markSessionClosed(session: AgentSession): void {
    session.closed = true;
    releaseSessionPayloads(session);
    releaseSseAdmission(session);
    session.backgroundJobs.clear();
    notifyAll(session);
}

const sessions = new Map<string, AgentSession>();

/** Forward disconnect/deadline to every run-owned waiter via session listeners. */
export function attachSessionTransport(session: AgentSession, signal: AbortSignal): () => void {
    if (session.transportError)
        throw session.transportError;
    if (session.closed)
        throw new ConnectError('Agent transport session is closed; use a new request ID', Code.FailedPrecondition);
    if (session.transportSignal)
        throw new ConnectError('Agent transport request ID already has a RunSSE consumer', Code.AlreadyExists);
    session.transportSignal = signal;
    session.expectedBlobReplies = new Map();
    if (session.expirationTimer) {
        clearTimeout(session.expirationTimer);
        session.expirationTimer = undefined;
    }
    const onAbort = (): void => markSessionClosed(session);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted)
        onAbort();
    return () => signal.removeEventListener('abort', onAbort);
}

/** Called at the registered output boundary, immediately before yielding. */
export function recordSessionBlobRequestSent(session: AgentSession, frame: AgentServerMessage): void {
    if (frame.message.case !== 'kvServerMessage')
        return;
    const envelope = frame.message.value;
    const requestKind = envelope.message.case;
    if (requestKind !== 'getBlobArgs' && requestKind !== 'setBlobArgs')
        return;
    const expectedReplies = session.expectedBlobReplies;
    if (!expectedReplies)
        return;
    for (const requestId of expectedReplies.keys()) {
        if (!session.activeBlobRequestIds?.has(requestId))
            expectedReplies.delete(requestId);
    }
    expectedReplies.set(envelope.id, requestKind === 'getBlobArgs' ? 'getBlobResult' : 'setBlobResult');
}

function expireSessionLater(session: AgentSession): void {
    if (session.expirationTimer)
        clearTimeout(session.expirationTimer);
    session.expirationTimer = setTimeout(() => {
        markSessionClosed(session);
        if (sessions.get(session.requestId) === session)
            sessions.delete(session.requestId);
    }, SESSION_RETENTION_MS);
    session.expirationTimer.unref?.();
}

export function getOrCreateSession(requestId: string): AgentSession {
    let session = sessions.get(requestId);
    if (!session) {
        if (liveSseSessions >= MAX_LIVE_SSE_SESSIONS)
            throw new ConnectError('Agent transport live SSE session limit exceeded', Code.ResourceExhausted);
        // 复用 createEphemeralSession —— 两处各自写字面量时,新增字段容易只补一处
        session = createEphemeralSession(requestId);
        session.holdsSseAdmission = true;
        liveSseSessions++;
        sessions.set(requestId, session);
        // BidiAppend may precede RunSSE. Unclaimed input cannot live forever.
        expireSessionLater(session);
        logger.debug({ requestId }, '[SESSION] created');
    }
    return session;
}

function isUnsolicitedBlobReply(session: AgentSession, json: Record<string, unknown>): boolean {
    const envelope = json.kvClientMessage as Record<string, unknown> | undefined;
    if (!envelope || !('getBlobResult' in envelope || 'setBlobResult' in envelope))
        return false;
    if (typeof envelope.id !== 'number' || !session.activeBlobRequestIds?.has(envelope.id))
        return true;
    const expectedKind = session.expectedBlobReplies?.get(envelope.id);
    return !expectedKind || !(expectedKind in envelope);
}

/** Decode both official encodings, then release only contiguous append seqnos. */
export function appendMessage(requestId: string, data: string, appendSeqno: bigint, dataBinary: Uint8Array): void {
    if (appendSeqno < 0n)
        throw new ConnectError('BidiAppend append_seqno must be non-negative', Code.InvalidArgument);
    if (data && (data.length % 2 !== 0 || !/^[\da-f]+$/i.test(data)))
        throw new ConnectError('BidiAppend data must be a hexadecimal protobuf payload', Code.InvalidArgument);
    const hexBytes = data ? Buffer.from(data, 'hex') : undefined;
    if (hexBytes && dataBinary.length && !hexBytes.equals(dataBinary))
        throw new ConnectError('BidiAppend data and data_binary disagree', Code.InvalidArgument);
    const bytes = dataBinary.length ? dataBinary : hexBytes;
    if (!bytes?.length)
        throw new ConnectError('BidiAppend requires data or data_binary', Code.InvalidArgument);

    const session = getOrCreateSession(requestId);
    if (session.closed || session.cancelledReason !== undefined)
        throw new ConnectError('BidiAppend session is closed; use a new request ID', Code.FailedPrecondition);
    const sequence = session.appendSequence ??= { nextSequence: 0n, pending: new Map(), pendingBytes: 0 };
    // 3.14.27 agent-host: l=0; seqno=l++; at most 32 in-flight sends;
    // retry attempts reuse the original seqno and identical protobuf bytes.
    if (appendSeqno < sequence.nextSequence)
        return;
    const digest = createHash('sha256').update(bytes).digest('hex');
    const pending = sequence.pending.get(appendSeqno);
    if (pending) {
        if (pending.digest !== digest)
            rejectSession(session, new ConnectError('BidiAppend reused a pending seqno with different data', Code.InvalidArgument));
        return;
    }

    let json: Record<string, unknown>;
    try {
        const clientMsg = fromBinary(AgentClientMessageSchema, bytes);
        json = toJson(AgentClientMessageSchema, clientMsg) as Record<string, unknown>;
    } catch (error) {
        rejectSession(session, new ConnectError('BidiAppend contains invalid AgentClientMessage protobuf', Code.InvalidArgument, undefined, undefined, error));
    }
    // Decide at arrival, NOT after reordering: an early/stale ACK cannot become
    // valid merely because its target id gets allocated while an earlier seqno
    // is missing. Keep a sequence placeholder, not the unsolicited blob bytes.
    const message = 'clientHeartbeat' in json || isUnsolicitedBlobReply(session, json) ? null : json;
    const byteLength = message ? bytes.byteLength : 0;
    if (appendSeqno === sequence.nextSequence) {
        // Gap-filling input need not occupy another reorder slot. In-order
        // cancellation can release a full budget without first charging itself.
        sequence.nextSequence++;
        if (message)
            ingestSessionMessage(session, message, byteLength);
    }
    else {
        if (sequence.pending.size >= MAX_PENDING_APPENDS)
            rejectSessionResource(session, 'BidiAppend pending sequence buffer exceeded its limit');
        chargeTransportBytes(session, byteLength);
        sequence.pending.set(appendSeqno, { message, digest, byteLength });
        sequence.pendingBytes += byteLength;
    }
    while (!session.closed) {
        const nextAppend = sequence.pending.get(sequence.nextSequence);
        if (!nextAppend)
            break;
        sequence.pending.delete(sequence.nextSequence++);
        sequence.pendingBytes -= nextAppend.byteLength;
        // Transfer ownership synchronously: a discarded/control frame releases
        // its charge; ordinary ingestion takes the same bytes without doubling.
        retainedTransportBytes -= nextAppend.byteLength;
        if (nextAppend.message)
            ingestSessionMessage(session, nextAppend.message, nextAppend.byteLength);
    }
}

/**
 * 等待匹配特定条件的消息
 *
 * 不匹配的消息会被跳过（留在队列中供后续消费）。
 * 用于在 tool call 场景下等待 execClientMessage，
 * 而不被 kvClientMessage/clientHeartbeat 干扰。
 */
export async function waitForMessageMatching(
    session: AgentSession,
    predicate: (msg: Record<string, unknown>) => boolean,
    timeoutMs: number | null = 30_000,
    signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
    if (signal?.aborted) return null;
    // 先检查队列中是否已有匹配消息
    const idx = session.messages.findIndex(predicate);
    if (idx >= 0) {
        return takeSessionMessage(session, idx);
    }
    // cancelled 与 closed 同样立即结束等待 —— 调用方 (wait.ts) 据
    // session.cancelledReason 区分二者,把前者转成 AgentRunAbortedError
    if (session.closed || session.cancelledReason !== undefined) return null;

    return new Promise<Record<string, unknown> | null>((resolve) => {
        let resolved = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const abortListener = () => {
            if (resolved)
                return;
            cleanup();
            resolve(null);
        };

        const listener = () => {
            if (resolved)
                return;
            const i = session.messages.findIndex(predicate);
            if (i >= 0) {
                cleanup();
                resolve(takeSessionMessage(session, i));
                return;
            }
            if (session.closed || session.cancelledReason !== undefined) {
                cleanup();
                resolve(null);
            }
        };

        function cleanup(): void {
            resolved = true;
            if (timer != null)
                clearTimeout(timer);
            session.listeners.delete(listener);
            signal?.removeEventListener('abort', abortListener);
        }

        session.listeners.add(listener);
        signal?.addEventListener('abort', abortListener, { once: true });
        if (signal?.aborted) {
            abortListener();
            return;
        }
        timer = timeoutMs == null ? null : setTimeout(() => {
            if (resolved)
                return;
            cleanup();
            logger.warn({ requestId: session.requestId, timeoutMs }, '[SESSION] waitForMessage timeout');
            resolve(null);
        }, timeoutMs);
    });
}

export async function waitForInteractionResponse(
    session: AgentSession,
    id: number,
    expectedCase: string,
    timeoutMs: number | null = 60_000,
): Promise<Record<string, unknown> | null> {
    return waitForMessageMatching(
        session,
        (msg) => {
            if (!('interactionResponse' in msg)) return false;
            const response = msg.interactionResponse as Record<string, unknown> | undefined;
            if (!response) return false;
            const responseId = typeof response.id === 'number' ? response.id : Number(response.id);
            return responseId === id && expectedCase in response;
        },
        timeoutMs,
    );
}

export function closeSession(requestId: string): void {
    const session = sessions.get(requestId);
    if (session) {
        markSessionClosed(session);
        // A short closed-session tombstone rejects in-flight append retries.
        // Retain no queued payloads while the recent transport ID stays closed.
        expireSessionLater(session);
        logger.debug({ requestId }, '[SESSION] closed');
    }
}
