import type { RunInferenceClientMessage, RunInferenceServerMessage } from '../../gen/native_inference_pb';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { RunInferenceServerMessageSchema } from '../../gen/native_inference_pb';
import { logger } from '../../logger';
import { createRunReady, forwardInference } from './forward';

export class InferenceQueue<T> implements AsyncIterable<T> {
    private items: T[] = [];
    private waiter?: () => void;
    private ended = false;
    private error?: unknown;

    push(value: T): void {
        if (this.ended) return;
        if (this.items.length >= 1024) throw new ConnectError('Inference queue overflow.', Code.ResourceExhausted);
        this.items.push(value);
        this.waiter?.();
    }

    end(error?: unknown): void {
        this.ended = true;
        this.error = error;
        this.waiter?.();
    }

    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
        for (;;) {
            if (this.items.length) { yield this.items.shift()!; continue; }
            if (this.ended) {
                if (this.error) throw this.error;
                return;
            }
            await new Promise<void>(resolve => { this.waiter = resolve; });
            this.waiter = undefined;
        }
    }
}

export async function* runInferenceSession(incoming: AsyncIterable<RunInferenceClientMessage>, signal: AbortSignal): AsyncGenerator<RunInferenceServerMessage> {
    const outgoing = new InferenceQueue<RunInferenceServerMessage>();
    const active = new Map<string, AbortController>();
    const invoked = new Set<string>();
    const tasks = new Set<Promise<void>>();
    const runAbort = new AbortController();
    let modelId: string | undefined;
    let finished = false;
    const send = (message: Parameters<typeof create<typeof RunInferenceServerMessageSchema>>[1]) => outgoing.push(create(RunInferenceServerMessageSchema, message));
    const abort = () => {
        runAbort.abort();
        for (const controller of active.values()) controller.abort();
        outgoing.end();
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const heartbeat = setInterval(() => send({ message: { case: 'heartbeat', value: {} } }), 10_000);
    heartbeat.unref();
    const handshakeTimeout = setTimeout(() => outgoing.end(new ConnectError('Native inference did not receive its run request.', Code.DeadlineExceeded)), 30_000);
    handshakeTimeout.unref();
    const pump = (async () => {
        try {
            for await (const { message } of incoming) {
                if (runAbort.signal.aborted || finished) break;
                switch (message.case) {
                    case 'runRequest': {
                        if (modelId) throw new ConnectError('Duplicate inference run request.', Code.InvalidArgument);
                        const ready = createRunReady(message.value);
                        clearTimeout(handshakeTimeout);
                        modelId = ready.resolvedModel!.modelId;
                        send({ message: { case: 'runReady', value: ready } });
                        logger.info({ model: modelId }, '[NATIVE_INFERENCE] run ready');
                        break;
                    }
                    case 'invokeModel': {
                        if (!modelId || !message.value.request || !message.value.invocationId) throw new ConnectError('Inference invocation requires a run and request.', Code.InvalidArgument);
                        const invoke = message.value;
                        const id = invoke.invocationId;
                        if (invoked.has(id)) throw new ConnectError('Duplicate inference invocation.', Code.AlreadyExists);
                        invoked.add(id);
                        const controller = new AbortController();
                        active.set(id, controller);
                        const invocationModel = invoke.request!.requestedModel?.modelId || invoke.request!.modelId || modelId;
                        const task = (async () => {
                            try {
                                logger.info({ model: invocationModel, purpose: invoke.purpose, messageCount: invoke.request!.messages.length }, '[NATIVE_INFERENCE] forwarding invocation');
                                for await (const response of forwardInference(invoke.request!, invocationModel, controller.signal)) {
                                    send({ message: { case: 'invocationResponse', value: { invocationId: id, response } } });
                                }
                                send({ message: { case: 'invocationEnd', value: { invocationId: id } } });
                            } catch (error) {
                                const e = controller.signal.aborted ? new ConnectError('Inference invocation cancelled.', Code.Canceled) : ConnectError.from(error);
                                send({ message: { case: 'invocationEnd', value: { invocationId: id, error: { code: e.code, message: e.rawMessage } } } });
                            } finally {
                                active.delete(id);
                            }
                        })();
                        tasks.add(task);
                        void task.finally(() => tasks.delete(task));
                        break;
                    }
                    case 'cancelInvocation':
                        active.get(message.value.invocationId)?.abort();
                        break;
                    case 'finishRun':
                        finished = true;
                        abort();
                        return;
                    case 'clientHeartbeat':
                        break;
                    default:
                        throw new ConnectError('Unsupported native inference control message.', Code.Unimplemented);
                }
            }
            abort();
        } catch (error) {
            for (const controller of active.values()) controller.abort();
            outgoing.end(error);
        }
    })();
    try {
        yield* outgoing;
    } finally {
        clearInterval(heartbeat);
        clearTimeout(handshakeTimeout);
        signal.removeEventListener('abort', abort);
        abort();
        await Promise.allSettled([...tasks]);
        // A disconnected SSE producer is closed by the service's finally block;
        // do not wait on an input iterator that can still be awaiting BidiAppend.
        void pump;
    }
}
