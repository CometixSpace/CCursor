/**
 * aiserver.v1.BidiService — Bidi 辅助服务
 *
 * 1 方法:
 *   - BidiAppend (unary) — 向 bidi 流追加消息
 *     SSE 降级模式下，data 承载 hex protobuf (也可用 dataBinary)。
 *     SSE 端点决定解码为 AgentClientMessage 或 RunInferenceClientMessage。
 *
 * Transport: backendUrl (api2.cursor.sh)
 */
import type { ConnectRouter } from '@connectrpc/connect';
import { BidiService } from '../../gen/aiserver_v1_pb';
import { appendBidiMessage } from '../../handlers/bidiMailbox';
import { logger } from '../../logger';

export default (router: ConnectRouter) => {
    router.service(BidiService, {
        bidiAppend: async (req) => {
            const requestId = req.requestId?.requestId;
            const data = req.data || Buffer.from(req.dataBinary).toString('hex');
            if (requestId && data) {
                logger.info({ requestId, dataLen: req.data.length, seqno: Number(req.appendSeqno) }, '[SVC] BidiAppend');
                appendBidiMessage(requestId, req.appendSeqno, data);
            } else {
                logger.warn({ hasRequestId: !!requestId, hasData: !!req.data }, '[SVC] BidiAppend missing fields');
            }
            return {};
        },
    });
};
