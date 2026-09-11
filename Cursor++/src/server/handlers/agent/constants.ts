// Compatibility and heuristic constants shared across the agent runtime.
//
// Categorization:
// - compatibility default: chosen to match stable Cursor client behavior and avoid idle stalls
// - heuristic: local compaction policy, not protocol-defined by Cursor
// - UX timeout: conservative defaults for interactive tool execution

// Keep the agent stream active under common ~5s idle UI/proxy thresholds.
// This is a compatibility/UX interval, not a Cursor protocol requirement.
export const AGENT_HEARTBEAT_INTERVAL_MS = 4_000;

// Foreground shell commands should finish promptly during an agent turn.
// Longer operations should explicitly opt into background-style execution.
export const SHELL_DEFAULT_TIMEOUT_MS = 30_000;

// Cursor shell exec args support a much larger hard timeout for long-running commands.
// Keep aligned across started/exec arg builders.
export const SHELL_HARD_TIMEOUT_MS = 86_400_000;

// Forwarded to Cursor shell exec args to avoid overly large inline file output payloads.
// Compatibility-oriented default in the current implementation.
export const SHELL_FILE_OUTPUT_THRESHOLD_BYTES = 40_000n;

// Cursor shell timeout behavior enum value.
//
// IMPORTANT: 对齐 3.0.16 proto 的 agent.v1.TimeoutBehavior enum:
//   UNSPECIFIED = 0
//   CANCEL = 1
//   BACKGROUND = 2   ← 这里
//
// Bug 历史: 此常量原为 1, 对应 CANCEL, 导致 Cursor 客户端把 shell tool call
// 误识别为 "cancelled" 状态, UI 触发 fallback 显示 "Command failed to generate".
// 修正为 2 (BACKGROUND) 之后, shell tool call 在 UI 里显示为正常的后台执行态.
// 详见 analysis/checkpoint-revert-protocol.md 的 Round D 记录.
export const SHELL_TIMEOUT_BEHAVIOR_BACKGROUND = 2;

// 空窗期 idle hint: 模型输出文本后长时间无新事件时,
// 注入 thinkingCompleted 让客户端从 streaming_text 转到 waiting_server_next,
// 下一个 heartbeat 将触发 "Generating response" 状态显示。
// 避免兼容性较差的模型提供商 (如 GLM 不流式 tool_use) 导致 UI 看起来卡死。
export const IDLE_HINT_AFTER_MS = 3_000;

// ═══════════════════════════════════════════════════════════════════
// 第二阶段: keepTail 预算化参数 (设计文档 §5 参数表, 唯一权威为该表)
// 公式集中于此, planCompaction / usage / 摘要侧共享, 禁止散落内联数字。
// ═══════════════════════════════════════════════════════════════════

/** 触发线 = 窗口 − min(该值, 15% × 窗口)。审计三修正: 双轨 min(max−40K, 0.85max) 在小窗死带, 改为单一预留式 */
export const AUTOCOMPACT_TRIGGER_RESERVE_MAX_TOKENS = 40_000;
export const AUTOCOMPACT_TRIGGER_RESERVE_RATIO = 0.15;

/** 压缩后地板目标 = 25% × 窗口 (258,400 窗 → 64,600) */
export const TARGET_FLOOR_RATIO = 0.25;

/** 摘要预留 = min(5K, 2% × 窗口) — 按窗口比例缩放 (审计四小窗修正) */
export const SUMMARY_RESERVE_MAX_TOKENS = 5_000;
export const SUMMARY_RESERVE_RATIO = 0.02;

/** keepTail 预算 clamp 下限 = min(8K, 5% × 窗口); 上限固定 60K (1M 窗 25%=250K 失去压缩意义) */
export const KEEP_TAIL_BUDGET_MIN_TOKENS = 8_000;
export const KEEP_TAIL_BUDGET_MIN_RATIO = 0.05;
export const KEEP_TAIL_BUDGET_MAX_TOKENS = 60_000;

/** 巨物线 = max(4K, min(12K, 25% × budget)); 超线的 tool_result/大字段参与占位计价 */
export const LARGE_ENTRY_MIN_TOKENS = 4_000;
export const LARGE_ENTRY_MAX_TOKENS = 12_000;
export const LARGE_ENTRY_BUDGET_RATIO = 0.25;

/** 摘要输出硬上界 = 2 × summaryReserve (审计四: 官方 prompt 第 6 节随会话年龄单调增长) */
export const SUMMARY_HARD_CAP_RESERVE_MULTIPLE = 2;

/** 占位预览 = 头 175 tok + 尾 75 tok (token 封顶, CJK 不击穿; 尾部信息密度高) */
export const PLACEHOLDER_PREVIEW_HEAD_TOKENS = 175;
export const PLACEHOLDER_PREVIEW_TAIL_TOKENS = 75;

/**
 * 图片计价 = 1,600 tok/块。
 * 校准清单项: 非跨 provider 普适常数 (审计二 Gemini 小图实测 ~258 tok/图),
 * 由 o200k vs provider usage 观测差校准; 仅用于预算计价, 不用于计费。
 */
export const IMAGE_BILLED_TOKENS = 1_600;

/** 违约判定 = 实占 > 承诺地板 × 1.2 (扣除因果前沿超额后) */
export const FLOOR_VIOLATION_RATIO = 1.2;

/** 预算安全边际: o200k 是校准估计器 (非 OpenAI 系偏差 10-15%), 计价乘 1.15 由观测校准 */
export const BUDGET_SAFETY_MARGIN = 1.15;

/** 可行性检查的固定输出预留; planCompaction 不感知 provider 的 maxOutputTokens。 */
export const FEASIBILITY_OUTPUT_RESERVE_TOKENS = 20_000;

/** 摘要源总预算 = min(0.6 × 窗口 × 4, 3.2e6) chars; min-quota 200 chars (官方 CC-012) */
export const SUMMARY_SOURCE_WINDOW_RATIO = 0.6;
export const SUMMARY_SOURCE_MAX_CHARS = 3_200_000;
export const SUMMARY_SOURCE_MIN_QUOTA_CHARS = 200;

/** 摘要三级兜底 (官方 CC-011 库参数全量接线, 官方生产只接线两级) */
export const SUMMARY_RETRY_MAX_ATTEMPTS = 3;
export const SUMMARY_RETRY_MIN_BUDGET_CHARS = 50_000;
export const SUMMARY_RETRY_MAX_INPUT_RATIO = 0.75;
/** 确定性降级预算 = clamp(窗口 × 2% × 4, 50K, 3.2e6) chars */
export const SUMMARY_FALLBACK_WINDOW_RATIO = 0.02;
export const SUMMARY_FALLBACK_MIN_CHARS = 50_000;
export const SUMMARY_FALLBACK_MAX_CHARS = 3_200_000;

/** 错误驱动压缩重试上限 (官方 5 轮, BYOK 单轮成本更高取保守值) */
export const CONTEXT_LENGTH_RETRY_MAX = 3;

/**
 * 摘要流 idle 超时 = 300s, 逐字对齐 Codex DEFAULT_STREAM_IDLE_TIMEOUT_MS
 * (codex-rs/model-provider-info, 2026-08-29 三方调研)。
 *
 * 上游对齐决策 (官方可学学官方, 不可学学 Codex, 非必要不自创):
 * - 超时形态: 官方客户端侧无摘要超时 (托管通道兜底) — BYOK 无托管通道不可学;
 *   学 Codex: 单一 idle-only 计时 (事件间无活动 300s 判死), 无首字特判、
 *   无总时长上限。宽松 300s 是为容纳推理模型黑箱思考期 (与两家一致,
 *   摘要请求不传 reasoning 参数, 思考期零事件属正常形态)。
 * - 有界性: 挂死网关最坏路径 = 3 次尝试 × 300s idle → 确定性降级;
 *   真实挂死通常 TCP 层快速报错, 300s 静默是理论上界而非常态。
 * - 实弹事故 (4 分钟黑箱思考被误判挂死) 在此形态下自然消解:
 *   思考 4 分钟 < 300s idle, 思考完成后正常出流。
 */
export const SUMMARY_STREAM_IDLE_TIMEOUT_MS = 300_000;

/** 入口截断 (阶段 1): ENTRY_CAP = min(25K tok, 25% × 窗口) */
export const TASK_ENTRY_CAP_RATIO = 0.25;
