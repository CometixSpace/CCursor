import type { LLMUsage } from '../llm/types';

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
 * 自动压缩触发判定 — 绝对 buffer 模式
 *
 * 参考 Claude Code (buffer=13K, outputReserve=20K) 但为 Cursor IDE 场景加大预留:
 *
 * Cursor Agent 每轮有 IDE 专属固定开销——system prompt + preamble (~15K),
 * 注册工具 schema (~10K), rules/skills/MCP instructions (~5K),
 * exec 通道封装 + blob 元数据开销。比 CLI 环境多 ~20-30K。
 *
 *   effectiveWindow = maxTokens - outputReserve(20K)
 *   threshold = effectiveWindow - bufferTokens(20K)
 *
 * 以 200K 模型 80% 触发为基准测算:
 *   128K 模型: threshold=88K  → ~69%, 留 40K 余量
 *   200K 模型: threshold=160K → ~80%, 留 40K 余量 ← 基准
 *   1M 模型:  threshold=960K → 96%, 留 40K 余量
 * 40K ≈ 2 轮 Agent tool 调用余量 (system 15K + tool result 15K + output 8K)
 */
const AUTOCOMPACT_BUFFER_TOKENS = 20_000
const MAX_OUTPUT_RESERVE = 20_000

export function getAutoCompactThreshold(maxTokens: number, maxOutputTokens = 8192): number {
    // 模型没配 contextTokenLimit 时窗口大小是 0: 无从判断占用, 不能让阈值算成负数而每轮必压
    if (!(maxTokens > 0)) return Infinity
    const outputReserve = Math.min(maxOutputTokens, MAX_OUTPUT_RESERVE)
    const effective = maxTokens - outputReserve
    return effective - AUTOCOMPACT_BUFFER_TOKENS
}

export function shouldTriggerCompaction(usedTokens: number, maxTokens: number, thresholdPercent?: number): boolean {
    if (thresholdPercent !== undefined) {
        return computeContextUsagePercent(usedTokens, maxTokens) >= thresholdPercent;
    }
    return usedTokens >= getAutoCompactThreshold(maxTokens);
}
