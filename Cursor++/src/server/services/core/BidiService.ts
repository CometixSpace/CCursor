/**
 * aiserver.v1.BidiService — Bidi 辅助服务
 *
 * 1 方法:
 *   - BidiAppend (unary) — 向 bidi 流追加消息
 *     SSE 降级模式下，客户端通过此方法发送 AgentClientMessage，
 *     data 为 hex protobuf，dataBinary 为原始 protobuf，requestId 关联到 RunSSE 流。
 *
 * Transport: backendUrl (api2.cursor.sh)
 */
import type { ConnectRouter } from '@connectrpc/connect';
import { Code, ConnectError } from '@connectrpc/connect';
import { BidiService } from '../../gen/aiserver_v1_pb';
import { appendMessage } from '../../handlers/agent/session';
import { logger } from '../../logger';

export default (router: ConnectRouter) => {
    router.service(BidiService, {
        bidiAppend: async (req) => {
            const requestId = req.requestId?.requestId;
            if (!requestId)
                throw new ConnectError('BidiAppend requires request_id.request_id', Code.InvalidArgument);
            logger.debug({ requestId, seqno: String(req.appendSeqno) }, '[SVC] BidiAppend');
            // This unary RPC completes after each append. Its context.signal
            // must not own the longer-lived RunSSE session.
            appendMessage(requestId, req.data, req.appendSeqno, req.dataBinary);
            return {};
        },
    });
};
