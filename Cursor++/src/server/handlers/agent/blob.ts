/**
 * KV Blob Store 处理
 *
 * Agent 协议使用 KV Blob Store 传输大块数据:
 *   - Server → Client: kvServerMessage.setBlobArgs { blobId, blobData }
 *   - Client → Server: kvClientMessage.setBlobResult { id? }
 *
 * blobData 是 base64 编码的 JSON，解码后为标准 LLM 消息格式:
 *   { "role": "system", "content": "..." }
 *   { "role": "user", "content": "..." }
 *   { "role": "assistant", "content": [...] }
 */
import { createHash } from 'crypto';

function finalizeBlobData(blobData: string): { blobId: string; blobData: string } {
    const blobId = createHash('sha256').update(blobData).digest('base64');
    return { blobId, blobData };
}

/** 将 JSON 对象编码为 blob (base64) 并计算 blobId (sha256) */
export function encodeBlob(data: unknown): { blobId: string; blobData: string } {
    const json = JSON.stringify(data);
    return finalizeBlobData(Buffer.from(json).toString('base64'));
}

/** 将 protobuf / binary 数据编码为 blob (base64) 并计算 blobId (sha256)。
 *  blobDataRaw 保留原始 bytes，供 kvMessage 直接发给客户端（fork 时客户端 fromBinary 需要 raw protobuf）。 */
export function encodeBinaryBlob(bytes: Uint8Array): { blobId: string; blobData: string; blobDataRaw: Uint8Array } {
    const { blobId, blobData } = finalizeBlobData(Buffer.from(bytes).toString('base64'));
    return { blobId, blobData, blobDataRaw: bytes };
}

/** 解码 blob base64 → JSON */
export function decodeBlob(blobData: string): unknown {
    const bytes = Buffer.from(blobData, 'base64');
    if (bytes.toString('base64') !== blobData)
        throw new Error('Non-canonical or invalid base64 blob data');
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(json);
}

/**
 * ── 与客户端 KV 存储之间的字节互转 ──
 *
 * Runtime data is retrieved through the client protocol; this says nothing
 * about the internal persistence policy of the official cloud service.
 * 线上字节形态由 stream.kvMessage 发 setBlobArgs 时决定, 两类 blob 不对称:
 *   - JSON blob (encodeBlob):      发 TextEncoder.encode(base64 文本) → 客户端存 base64 文本的 UTF-8 字节
 *   - 二进制 blob (encodeBinaryBlob): 发 raw bytes → 客户端存原始 protobuf 字节
 *   - 本项目生成的 blobId:          base64(sha256) 文本的 UTF-8 字节
 *   - Client fork IDs may be opaque raw hashes; preserve their exact bytes.
 * 取回时按 blob 种类做对应的逆运算, 得到 blobStore 约定的 base64 文本。
 */

const OPAQUE_BLOB_ID_PREFIX = 'blob-bytes:';

/** Keep legacy textual IDs unchanged; preserve client fork IDs without UTF-8 loss. */
export function blobIdFromBytes(bytes: Uint8Array): string {
    try {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        if (!text.startsWith(OPAQUE_BLOB_ID_PREFIX))
            return text;
    } catch {}
    // An internal representation only: this prefix is never sent on the wire.
    return OPAQUE_BLOB_ID_PREFIX + Buffer.from(bytes).toString('base64');
}

/** Legacy base64 hash TEXT is UTF-8 encoded, never decoded into a raw hash. */
export function blobIdToBytes(blobId: string): Uint8Array {
    if (blobId.startsWith(OPAQUE_BLOB_ID_PREFIX))
        return new Uint8Array(Buffer.from(blobId.slice(OPAQUE_BLOB_ID_PREFIX.length), 'base64'));
    return new TextEncoder().encode(blobId);
}

/**
 * 客户端回传的 JSON blob 字节 → blobStore 值 (base64 文本)。
 *
 * 实测客户端存的就是 base64 文本的 UTF-8 字节 (与旧 agent_blobs.blob_data 逐字节一致),
 * 直接 UTF-8 解码即可 —— 再做一次 base64 会双重编码。兜底: 裸 JSON 字节 (非本服务端
 * 写入的对话) 才 base64 编码。返回前用 decodeBlob 校验, 解不出 JSON 对象的返回 null。
 */
export function jsonBlobDataFromClientBytes(bytes: Uint8Array): string | null {
    if (bytes.length === 0) return null;
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const looksLikeRawJson = /^[\s]*[{[]/.test(text);
        const blobData = looksLikeRawJson ? Buffer.from(bytes).toString('base64') : text;
        const decoded = decodeBlob(blobData);
        return decoded !== null && typeof decoded === 'object' ? blobData : null;
    } catch {
        return null;
    }
}

/** 客户端回传的二进制 blob 字节 (turn / archive 等 protobuf) → blobStore 值 (base64 文本) */
export function binaryBlobDataFromClientBytes(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
}

/** 构造 system prompt blob */
export function buildSystemPromptBlob(modelId: string): { blobId: string; blobData: string } {
    return encodeBlob({
        role: 'system',
        content: `You are an AI coding assistant, powered by ${modelId}.\n\nYou operate in Cursor.\n\nYou are a coding agent that helps the USER with software engineering tasks.`,
    });
}

/** 构造 user message blob */
export function buildUserMessageBlob(
    text: string,
    env?: { osVersion?: string; shell?: string; workspacePaths?: string[] },
): { blobId: string; blobData: string } {
    let content = '';

    if (env) {
        content += '<user_info>\n';
        if (env.osVersion) content += `OS Version: ${env.osVersion}\n`;
        if (env.shell) content += `Shell: ${env.shell}\n`;
        if (env.workspacePaths?.length) content += `Workspace Path: ${env.workspacePaths[0]}\n`;
        content += '</user_info>\n\n';
    }

    content += `<user_query>\n${text}\n</user_query>`;

    return encodeBlob({ role: 'user', content });
}
