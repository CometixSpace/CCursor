import { createHash } from 'crypto';
import { create, toBinary } from '@bufbuild/protobuf';
import { ConversationSummaryArchiveSchema } from '../../gen/agent_v1_pb';
import { cacheBlob } from './blobStore';
import { encodeBlob } from './blob';
import {
    COMPACTION_LONG_BODY_KEEP_TAIL,
    COMPACTION_LONG_BODY_THRESHOLD,
    COMPACTION_MEDIUM_BODY_KEEP_TAIL,
    COMPACTION_MEDIUM_BODY_THRESHOLD,
} from './constants';
import type { LLMMessage } from '../llm/types';
import type { HistoryEntry } from './historyManager';
import { isPreambleUserMessage, isSummaryBlobMessage } from './historyManager';

export interface CompactionPlan {
    leading: HistoryEntry[];
    /** 交给模型写成摘要的部分 */
    summarizeEntries: HistoryEntry[];
    /** 其中被摘要取代的那些。钉在 tail 开头的用户指令两边都在, 不算 (见 planCompaction) */
    replacedEntries: HistoryEntry[];
    /** 摘要之后原样保留的部分 */
    keepTail: HistoryEntry[];
}

export interface CompactionArtifacts {
    summaryText: string;
    summaryBlobId: string;
    summaryBlobData: string;
    archiveBlobs: Array<{ blobId: string; blobData: string; blobDataRaw?: Uint8Array }>;
    nextRootBlobIds: string[];
    nextSummaryArchiveIds: string[];
}

/**
 * 被摘要吞掉的 MCP schema 占位符。
 *
 * GetDynamicTools 返回的是工具 schema —— 事实性数据,不是对话历史。
 * 把它原样喂给摘要器有两个害处:
 *   1. 单次 namespace 查询约 6k tokens,白白撑大 summary prompt
 *   2. 摘要成自然语言后 schema 精度丢失,而 LLM 会"记得"自己查过这些工具,
 *      于是拿着编造的参数去调 CallDynamicTool
 *
 * 好在 <dynamic_tools> 段在 system prompt 里,compaction 的 leading 会完整保留 ——
 * namespace 清单不丢,只丢 schema。所以这里显式告诉后续轮次"重查一次"即可。
 */
const DYNAMIC_TOOLS_SCHEMA_PLACEHOLDER
    = '<tool schemas omitted from summary — call GetDynamicTools again before using these tools>';

function formatToolResultForSummary(toolName: string | undefined, content: string): string {
    if (toolName === 'GetDynamicTools')
        return `[tool result] GetDynamicTools: ${DYNAMIC_TOOLS_SCHEMA_PLACEHOLDER}`;
    return `[tool result] ${toolName ?? ''}: ${content.trim()}`;
}

export function formatMessageForSummary(message: LLMMessage): string {
    const lines: string[] = [];

    if (typeof message.content === 'string') {
        const text = message.content.trim();
        // OpenAI/Gemini 形态: 工具结果是 role='tool' 的字符串消息。
        // 只拦 GetDynamicTools,其余保持原有输出格式不动。
        if (message.role === 'tool' && message.toolName === 'GetDynamicTools')
            lines.push(formatToolResultForSummary(message.toolName, text));
        else if (text)
            lines.push(text);
    } else {
        for (const block of message.content) {
            switch (block.type) {
                case 'text':
                    if (block.text.trim()) lines.push(block.text.trim());
                    break;
                case 'thinking':
                    if (block.text.trim()) lines.push(`[thinking] ${block.text.trim()}`);
                    break;
                case 'tool_use':
                    lines.push(`[tool call] ${block.name} ${JSON.stringify(block.input)}`);
                    break;
                case 'tool_result':
                    // Anthropic 形态: 工具结果是 user 消息里的 content block
                    lines.push(formatToolResultForSummary(block.toolName ?? block.toolUseId, block.content));
                    break;
            }
        }
    }

    const text = lines.join('\n').trim();
    return text ? `${message.role}:\n${text}` : '';
}

export function estimateTextTokens(text: string): number {
    return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateMessagesTokens(messages: Array<LLMMessage | { role: string; content: string }>): number {
    return messages.reduce((sum, message) => sum + estimateTextTokens(typeof message.content === 'string' ? message.content : formatMessageForSummary(message as LLMMessage)), 0);
}

export function planCompaction(entries: HistoryEntry[]): CompactionPlan {
    const leading: HistoryEntry[] = [];
    let index = 0;

    if (entries[index]?.message.role === 'system') {
        leading.push(entries[index]);
        index += 1;
    }
    if (entries[index] && isPreambleUserMessage(entries[index].message)) {
        leading.push(entries[index]);
        index += 1;
    }

    const body = entries.slice(index);
    let keepTailCount = body.length > COMPACTION_LONG_BODY_THRESHOLD
        ? COMPACTION_LONG_BODY_KEEP_TAIL
        : body.length > COMPACTION_MEDIUM_BODY_THRESHOLD
            ? COMPACTION_MEDIUM_BODY_KEEP_TAIL
            : 0;
    let summarizeCount = Math.max(0, body.length - keepTailCount);

    if (summarizeCount === 0 && body.length > COMPACTION_MEDIUM_BODY_THRESHOLD) {
        keepTailCount = COMPACTION_MEDIUM_BODY_KEEP_TAIL;
        summarizeCount = Math.max(0, body.length - keepTailCount);
    }

    // tool 配对完整性: 确保切分点不在 tool call/result 之间。
    //
    // 消息序列: assistant(tool_use:A) → tool(result:A) → assistant(tool_use:B) → tool(result:B)
    //
    // 如果 keepTail 以 tool role 开头, 其配对的 assistant(tool_use) 在 summarize 侧,
    // 发给 OpenAI 时报 "No tool call found for function call output"。
    //
    // 退到所属的 assistant 即止: 它的 tool results 都排在它后面, 已经在 tail 里。
    // 再往前退会把更早的工具轮次逐个拉回 tail, 长工具链里一条也压不掉。
    while (body[summarizeCount]?.message.role === 'tool' && summarizeCount > 0)
        summarizeCount--;

    // 用户的指令要有原文留在压缩后的历史里: 摘要是转述, 可能走样 (官方客户端的切分同样会回溯保留它)。
    // 长工具链里本轮的指令早已落在摘要一侧 —— tail 里有内容却没有用户消息时, 把最后一条指令的原文钉在
    // tail 开头。摘要一侧照样有它: 摘要要对着任务来写。tail 是空的就不钉: 那条指令已经答完了。
    const tail = body.slice(summarizeCount);
    const lastInstruction = tail.length === 0 || tail.some(isUserInstruction)
        ? undefined
        : body.slice(0, summarizeCount).filter(isUserInstruction).at(-1);
    const pinned = lastInstruction ? [lastInstruction] : [];

    const summarizeEntries = body.slice(0, summarizeCount);
    const replacedEntries = summarizeEntries.filter(entry => !pinned.includes(entry));

    // 被取代的一条也没有 (待摘要的只有钉在 tail 里的那条指令) 时没有东西可压。
    if (replacedEntries.length === 0)
        return { leading, summarizeEntries: [], replacedEntries: [], keepTail: body };

    return { leading, summarizeEntries, replacedEntries, keepTail: [...pinned, ...body.slice(summarizeCount)] };
}

/** 用户自己写的消息 —— 不算 tool_result 的载体, 也不算只带图片的附件消息。只看形态: 历史修复把落单的工具结果改写成的 user 文本也算。 */
function isUserInstruction(entry: HistoryEntry): boolean {
    const { role, content } = entry.message;
    return role === 'user'
        && (typeof content === 'string' ? content.trim().length > 0 : content.some(block => block.type === 'text'));
}

function encodeBinaryBlob(bytes: Uint8Array): { blobId: string; blobData: string; blobDataRaw: Uint8Array } {
    const blobData = Buffer.from(bytes).toString('base64');
    const blobId = createHash('sha256').update(blobData).digest('base64');
    return { blobId, blobData, blobDataRaw: bytes };
}

export function createCompactionArtifacts(params: {
    plan: CompactionPlan;
    summaryText: string;
    previousSummaryArchiveIds: string[];
}): CompactionArtifacts {
    const summaryBlob = encodeBlob({
        role: 'assistant',
        content: `Previous conversation summary:\n${params.summaryText}`,
        providerOptions: { cursor: { isSummary: true } },
    });
    cacheBlob(summaryBlob.blobId, summaryBlob.blobData);

    // 归档记的是被摘要取代的消息, 上一次压缩留下的摘要不算
    const archiveSourceBlobIds = params.plan.replacedEntries
        .filter(entry => !isSummaryBlobMessage(entry.raw))
        .map(entry => entry.blobId);

    const archiveBlobs: Array<{ blobId: string; blobData: string; blobDataRaw?: Uint8Array }> = [];
    let nextSummaryArchiveIds = [...params.previousSummaryArchiveIds];
    if (archiveSourceBlobIds.length > 0) {
        const encoder = new TextEncoder();
        const archiveMessage = create(ConversationSummaryArchiveSchema, {
            summarizedMessages: archiveSourceBlobIds.map(blobId => encoder.encode(blobId)),
            summary: params.summaryText,
            windowTail: params.plan.keepTail.length,
            summaryMessage: encoder.encode(summaryBlob.blobId),
        });
        const archiveBlob = encodeBinaryBlob(toBinary(ConversationSummaryArchiveSchema, archiveMessage));
        cacheBlob(archiveBlob.blobId, archiveBlob.blobData);
        archiveBlobs.push(archiveBlob);
        nextSummaryArchiveIds = [...nextSummaryArchiveIds, archiveBlob.blobId];
    }

    return {
        summaryText: params.summaryText,
        summaryBlobId: summaryBlob.blobId,
        summaryBlobData: summaryBlob.blobData,
        archiveBlobs,
        nextRootBlobIds: [
            ...params.plan.leading.map(entry => entry.blobId),
            summaryBlob.blobId,
            ...params.plan.keepTail.map(entry => entry.blobId),
        ],
        nextSummaryArchiveIds,
    };
}
