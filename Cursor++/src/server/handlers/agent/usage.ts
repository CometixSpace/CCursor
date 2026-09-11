import type { LLMUsage } from '../llm/types';
import {
    AUTOCOMPACT_TRIGGER_RESERVE_MAX_TOKENS,
    AUTOCOMPACT_TRIGGER_RESERVE_RATIO,
} from './constants';

export interface UsageTotals {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}

export function emptyUsageTotals(): UsageTotals {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
    };
}

export function addUsage(totals: UsageTotals, usage: LLMUsage): UsageTotals {
    return {
        inputTokens: totals.inputTokens + usage.inputTokens,
        outputTokens: totals.outputTokens + usage.outputTokens,
        cacheReadTokens: totals.cacheReadTokens + (usage.cacheReadTokens ?? 0),
        cacheWriteTokens: totals.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
    };
}

/**
 * 近似当前会话上下文占用。
 *
 * inputTokens 代表本轮完整 prompt 规模(含全部历史消息), 是最准确的上下文大小信号。
 * outputTokens 代表本轮新增 assistant 内容, 下一轮会被加入 prompt。
 * 两者相加 ≈ 下一轮的预期 inputTokens, 作为"下一轮上下文压力"的近似。
 */
export function estimateContextTokens(usage: LLMUsage): number {
    return Math.max(0, usage.inputTokens + usage.outputTokens);
}

export function clampTokenDetails(usedTokens: number, maxTokens: number): { usedTokens: number; maxTokens: number } {
    const safeMax = Math.max(1, maxTokens);
    return {
        usedTokens: Math.max(0, Math.min(usedTokens, safeMax)),
        maxTokens: safeMax,
    };
}

export function computeContextUsagePercent(usedTokens: number, maxTokens: number): number {
    const { usedTokens: safeUsed, maxTokens: safeMax } = clampTokenDetails(usedTokens, maxTokens);
    return Number(((safeUsed / safeMax) * 100).toFixed(2));
}

/**
 * 错误驱动压缩重试: provider 错误分类白名单 (设计文档 §7#9)。
 *
 * 只识别明确的 context-length / input-token-limit 类错误文案与错误码;
 * 非白名单错误走现状路径, 防止误把普通 provider 故障当成窗口压力。
 */
const CONTEXT_LENGTH_ERROR_PATTERNS: RegExp[] = [
    /context_length_exceeded/i,
    /maximum context length/i,
    /context length exceeded/i,
    /prompt is too long/i,
    /input token count exceeds/i,
    /too many input tokens/i,
    /input.*tokens?.*exceeds.*maximum/i,
    /context window.*exceeded/i,
    /request too large.*tokens/i,
]

export function isContextLengthLimitError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '')
    if (!message)
        return false
    return CONTEXT_LENGTH_ERROR_PATTERNS.some(pattern => pattern.test(message))
}

/**
 * 净增长门槛: 距上次"有效"压缩基线的净增长须达到该值才允许再次自动压缩。
 *
 * 压缩重置值只含对话消息 (chars/4), 而下一轮 provider usage 立刻把估算抬回
 * "压缩后对话 + 脚手架" —— 若无此门槛, 任何一次大文件读取都会再次越线,
 * 形成"读一个文件就压缩"的锯齿循环。逼近窗口上限的硬安全线可无视本门槛。
 */
export const AUTOCOMPACT_NET_GROWTH_MIN_TOKENS = 15_000

/**
 * 第二阶段触发预留: 触发线 = 窗口 − min(40K, 15% × 窗口)。
 *
 * planCompaction 可行性检查 (阶段 3) 与 getAutoCompactThreshold 新公式 (阶段 5)
 * 共享此函数。逐档值: 32K→27,200 / 64K→54,400 / 96K→81,600 /
 * 128K→108,800 / 258.4K→219,640 / 1M→960,000。
 */
export function computeAutoCompactTriggerReserveTokens(maxTokens: number): number {
    if (maxTokens <= 0)
        return 0;
    return Math.min(AUTOCOMPACT_TRIGGER_RESERVE_MAX_TOKENS, Math.floor(AUTOCOMPACT_TRIGGER_RESERVE_RATIO * maxTokens));
}

export function getAutoCompactThreshold(maxTokens: number): number {
    // 第二阶段新公式 (设计文档 §5 参数表, 审计三修正):
    //   threshold = 窗口 − min(40K, 15% × 窗口)
    // 逐档值: 32K→27,200 / 64K→54,400 / 96K→81,600 / 128K→108,800 /
    //         258.4K→219,640 / 1M→960,000
    // (旧双轨 min(max−40K, 0.85max) 在 max<266K 时恒由绝对轨主导, 32K 取到
    //  负值/64K 触发线 24K 逼近地板形成死带 — 详见设计文档 §5 触发公式行)
    if (maxTokens <= 0)
        return 0
    return maxTokens - computeAutoCompactTriggerReserveTokens(maxTokens)
}

export function shouldTriggerCompaction(usedTokens: number, maxTokens: number, thresholdPercent?: number): boolean {
    if (thresholdPercent !== undefined) {
        return computeContextUsagePercent(usedTokens, maxTokens) >= thresholdPercent;
    }
    return usedTokens >= getAutoCompactThreshold(maxTokens);
}
