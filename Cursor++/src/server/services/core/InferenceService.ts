import type { ConnectRouter } from '@connectrpc/connect';
import { fromBinary } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { InferenceService, RunInferenceClientMessageSchema } from '../../gen/native_inference_pb';
import { registerBidiReceiver } from '../../handlers/bidiMailbox';
import { forwardInference } from '../../handlers/inference/forward';
import { InferenceQueue, runInferenceSession } from '../../handlers/inference/session';

export default (router: ConnectRouter) => {
    router.service(InferenceService, {
        async* stream(request, context) {
            const model = request.requestedModel?.modelId || request.modelId;
            if (!model) throw new ConnectError('Missing inference model.', Code.InvalidArgument);
            yield* forwardInference(request, model, context.signal);
        },
        async* runInference(incoming, context) {
            yield* runInferenceSession(incoming, context.signal);
        },
        async* runInferenceSSE(request, context) {
            if (!request.requestId) throw new ConnectError('Missing inference SSE request id.', Code.InvalidArgument);
            const incoming = new InferenceQueue<ReturnType<typeof fromBinary<typeof RunInferenceClientMessageSchema>>>();
            const release = registerBidiReceiver(request.requestId, data => {
                incoming.push(fromBinary(RunInferenceClientMessageSchema, Buffer.from(data, 'hex')));
            });
            const close = () => incoming.end();
            context.signal.addEventListener('abort', close, { once: true });
            try {
                yield* runInferenceSession(incoming, context.signal);
            } finally {
                close(); release();
                context.signal.removeEventListener('abort', close);
            }
        },
    });
};
