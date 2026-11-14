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

// Heuristic compaction policy:
// preserve more recent turns uncompressed so continuation quality keeps short-term state.
// These values are local policy choices, not protocol-defined by Cursor.
export const COMPACTION_MEDIUM_BODY_THRESHOLD = 2;
export const COMPACTION_MEDIUM_BODY_KEEP_TAIL = 2;
export const COMPACTION_LONG_BODY_THRESHOLD = 8;
export const COMPACTION_LONG_BODY_KEEP_TAIL = 6;
// 条数之外再给 tail 一个体积上限 (占上下文窗口的比例), 压缩后才有余量再跑若干轮。
export const COMPACTION_TAIL_BUDGET_RATIO = 0.25;
