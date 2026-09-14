/**
 * Tool Call 处理
 *
 * Agent 协议中的工具调用生命周期 (从原始抓包分析):
 *
 * 1. LLM 返回 tool_use block:
 *    → partialToolCall (预告，参数未完成)
 *    → tokenDelta ×N (参数 tokens)
 *    → toolCallStarted (参数完整)
 *
 * 2. Server 发送执行指令给 Client:
 *    → execServerMessage (grepArgs/readArgs/writeArgs/shellStreamArgs/...)
 *
 * 3. Client 本地执行，通过 BidiAppend 回传:
 *    ← execClientMessage (grepResult/readResult/writeResult/...)
 *    ← execClientControlMessage (streamClose)
 *
 * 4. Server 收到结果:
 *    → kvServerMessage (保存工具结果 blob)
 *    → checkpoint (更新 token 计数)
 *    → toolCallCompleted (含完整 args + result)
 *
 * 5. 将结果喂回 LLM 继续生成 (可能触发更多 tool calls)
 *
 * 工具类型与 exec 通道映射 (from CURSOR_API_SPEC.md §9.4):
 *   shell      → shellStreamArgs / shellStream (流式: start/stdout/exit)
 *   glob       → grepArgs / grepResult (复用 grep 通道, outputMode=files_with_matches)
 *   grep       → grepArgs / grepResult
 *   read       → readArgs / readResult
 *   write/edit → writeArgs / writeResult
 *   delete     → deleteArgs / deleteResult
 *   readLints  → diagnosticsArgs / diagnosticsResult
 *   task       → subagentArgs / subagentResult
 *   await      → 分流: shell 走 readArgs/readResult (读 {terminalsFolder}/{shellId}.txt),
 *                subagent 走 subagentAwaitArgs/subagentAwaitResult。
 *                分流依据是 session 后台 job 注册表的 kind (见 toolRuntime.ts awaitToolCall 分支)。
 *   mcp        → mcpArgs / mcpResult
 *   webSearch  → 无 exec 通道 (Server 端执行)
 *   webFetch   → 无 exec 通道 (Server 端执行)
 *   askQuestion → 无 exec 通道 (Client UI 处理)
 *   updateTodos → 无 exec 通道 (Client 本地处理)
 */

import { logger } from '../../logger';
import type { EditPlan } from './toolkit/editPlans';
import { buildRegisteredEditPlan, buildRegisteredExecArgs, findToolByAlias, findToolByCursorType } from './toolRegistry';
import type { ToolExecBuildOptions } from './toolkit/types';

export interface AvailableMcpTool {
    name: string;
    providerIdentifier?: string;
    toolName?: string;
    /** 归属 server identifier — 回传 McpArgs.server_identifier,限定客户端工具查找范围 */
    serverIdentifier?: string;
}

export interface AvailableDynamicBuiltinTool {
    tool: string;
}

/**
 * 将 LLM 返回的字符串枚举值转换为 proto int32 枚举值
 *
 * LLM 通过 tool_use 返回的字段值可能是字符串 (如 "TODO_STATUS_PENDING")，
 * 但 proto 中定义的是 int32 enum。需要转换后才能正确序列化。
 */
const TODO_STATUS_MAP: Record<string, number> = {
    'TODO_STATUS_UNSPECIFIED': 0,
    'TODO_STATUS_PENDING': 1,
    'TODO_STATUS_IN_PROGRESS': 2,
    'TODO_STATUS_COMPLETED': 3,
    'TODO_STATUS_CANCELLED': 4,
    // 新 lowercase 枚举（官方 Cursor 工具使用）
    'pending': 1,
    'in_progress': 2,
    'completed': 3,
    'cancelled': 4,
};

const GOAL_STATUS_MAP: Record<string, number> = {
    'GOAL_STATUS_UNSPECIFIED': 0,
    'GOAL_STATUS_ACTIVE': 1,
    'GOAL_STATUS_PAUSED': 2,
    'GOAL_STATUS_COMPLETE': 3,
    'GOAL_STATUS_CLEARED': 4,
    'active': 1,
    'paused': 2,
    'complete': 3,
    'completed': 3,
    'cleared': 4,
};

/**
 * 将 LLM tool_use input 中的字符串枚举转换为 proto 兼容的 int32
 *
 * 目前处理:
 *   - TodoItem.status: "TODO_STATUS_PENDING" → 1
 */
export function sanitizeToolInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
    if (toolName === 'TodoWrite' && Array.isArray(input.todos)) {
        return {
            ...input,
            todos: (input.todos as Array<Record<string, unknown>>).map(todo => ({
                ...todo,
                status: typeof todo.status === 'string'
                    ? (TODO_STATUS_MAP[todo.status] ?? 0)
                    : todo.status,
            })),
        };
    }
    if ((toolName === 'UpdateGoal' || toolName === 'update_goal') && typeof input.status === 'string') {
        return {
            ...input,
            status: GOAL_STATUS_MAP[input.status] ?? 0,
        };
    }
    return input;
}

// extractToolResult 已移除 — 被 toolkit/results/* 的分模块实现完全替代。
// 旧代码用 switch-case 按 cursorToolType 硬编码,
// 新架构通过 toolResults.ts 链式调度到各 toolkit/results/*.ts 子模块。

/** LLM tool_use block → Cursor tool 类型映射 */
export interface ToolCallInfo {
    callId: string;
    name: string;
    input: Record<string, unknown>;
}

/**
 * 将 LLM tool name 映射到 Cursor 的 toolCall 类型
 *
 * LLM (Anthropic/OpenAI) 返回的 tool name 格式:
 *   read_file, write_file, shell, grep, glob, delete_file, ...
 *
 * Cursor 的 toolCall oneof 类型:
 *   shellToolCall, globToolCall, grepToolCall, readToolCall, editToolCall,
 *   deleteToolCall, readLintsToolCall, webSearchToolCall, webFetchToolCall,
 *   askQuestionToolCall, taskToolCall, mcpToolCall, updateTodosToolCall
 */
/** 解析 Claude/MCP 生态常见的扁平名 mcp__<server>__<tool>。 */
export function parseFlatMcpToolName(name: string): { server: string; toolName: string } | null {
    if (!name.startsWith('mcp__')) return null;
    const parts = name.split('__');
    if (parts.length < 3) return null;
    const server = parts[1];
    const toolName = parts.slice(2).join('__');
    return server && toolName ? { server, toolName } : null;
}

function resolveFlatMcpTool(
    parsed: { server: string; toolName: string },
    availableMcpTools: AvailableMcpTool[],
): AvailableMcpTool | undefined {
    return availableMcpTools.find(tool =>
        tool.toolName === parsed.toolName
        && (tool.serverIdentifier === parsed.server || tool.providerIdentifier === parsed.server));
}

export function mapToolName(llmToolName: string): string {
    return findToolByAlias(llmToolName)?.cursorToolType
        ?? (parseFlatMcpToolName(llmToolName) ? 'mcpToolCall' : llmToolName);
}

/**
 * partialToolCall 预告帧的类型 —— 返回 null 表示本轮不发预告帧。
 *
 * 预告帧发出时 tool_use 的参数尚未到达,只有 LLM 侧工具名可用。对
 * CallDynamicTool 而言真实身份藏在 arguments.namespace/toolName 里,此刻
 * 无从判定,只能猜一个 —— 而猜错的代价是不可逆的:
 *
 * 客户端按 toolCall.tool.case 分派 handler。editToolCall / updateTodosToolCall /
 * shellToolCall / createPlanToolCall / taskToolCall / askQuestionToolCall 六种
 * 走 specialToolHandlers,其余走通用路径。通用路径的 upsertToolFormerBubbleData
 * 会写 tool 字段,允许后续帧改型;而 specialToolHandler 命中已有 bubble 时只
 * setBubbleData(status/params/toolCall),**不写 toolCallType** ——
 * bubble 被预告帧的类型永久锁死 (3.15.6 / 3.16.29 / 3.17.19 行为一致)。
 *
 * 于是 CallDynamicTool(cursor, Task) 猜成 mcpToolCall 后,即便 toolCallStarted
 * 发的是 taskToolCall,UI 仍渲染成 MCP 菱形图标。预告帧本就是可选的
 * (handlePartialToolCall 只做 markToolCallAsUnfinished + 建预览 bubble),
 * 省掉它,让 toolCallStarted 一次给出准确类型。
 *
 * GetDynamicTools 不在此列 —— 它的 cursorToolType 固定为 getMcpToolsToolCall,
 * 不存在歧义,预告帧照发。
 */
export function mapPartialToolName(llmToolName: string): string | null {
    if (isDynamicInvokeToolName(llmToolName)) return null;
    if (llmToolName.startsWith('user-')) return 'mcpToolCall';
    return mapToolName(llmToolName);
}

/**
 * CallDynamicTool 的别名集合。
 *
 * CallDynamicTool / call_dynamic_tool 是官方 3.15.6 起的名字;
 * CallMcpTool / call_mcp_tool 是本项目早期实现与旧版本的参数名,保留兼容,
 * 避免会话中途升级时正在进行的调用失配。
 */
const DYNAMIC_INVOKE_ALIASES = new Set([
    'CallDynamicTool',
    'call_dynamic_tool',
    'CallMcpTool',
    'call_mcp_tool',
]);

export function isDynamicInvokeToolName(llmToolName: string): boolean {
    return DYNAMIC_INVOKE_ALIASES.has(llmToolName);
}

export interface DynamicInvokeTarget {
    /** 官方用 serverIdentifier (如 user-ida-pro-mcp);保留 cursor 作为内置保留字 */
    namespace: string;
    toolName: string;
    args: Record<string, unknown>;
    /** arguments 存在但不是 JSON object —— 官方 schema 要求 object,须拒绝 */
    invalidArgs: boolean;
}

/**
 * 解包 CallDynamicTool 的路由目标 —— 纯函数,无日志无副作用。
 *
 * 参数名兼容三种来源: 官方 namespace/toolName/arguments、
 * snake_case 变体、以及本项目早期的 server/args。
 */
export function parseDynamicInvoke(
    llmToolName: string,
    input: Record<string, unknown>,
): DynamicInvokeTarget | null {
    if (!isDynamicInvokeToolName(llmToolName)) return null;
    const rawArgs = input.arguments ?? input.args;
    const invalidArgs = rawArgs !== undefined
        && (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs));
    return {
        namespace: String(input.namespace ?? input.server ?? ''),
        toolName: String(input.toolName ?? input.tool_name ?? ''),
        args: !invalidArgs && rawArgs && typeof rawArgs === 'object'
            ? rawArgs as Record<string, unknown>
            : {},
        invalidArgs,
    };
}

/**
 * 一次 tool call 最终执行的是哪个工具。
 *
 * cursor namespace 下 CallDynamicTool 只是信封,真正执行的是内置工具本身。
 * 分流 (conversationRuntime Phase 1 的 Task 并发启动) 与执行
 * (toolRuntime 的 executionToolName) 必须用同一套判据,否则会出现
 * "分流当 MCP、执行当 Task" 这类自相矛盾的状态。
 *
 * 未注册的 toolName 不展开 —— 保持与 resolveToolCall 一致,让它走
 * resolutionError 把错误反馈给 LLM,而不是在这里静默当成原生工具启动。
 */
export function resolveExecutionToolName(
    llmToolName: string,
    input: Record<string, unknown>,
    availableDynamicBuiltinTools: AvailableDynamicBuiltinTool[] = [],
): string {
    const target = parseDynamicInvoke(llmToolName, input);
    if (!target || target.namespace !== 'cursor' || target.invalidArgs)
        return llmToolName;
    return availableDynamicBuiltinTools.some(tool => tool.tool === target.toolName)
        ? target.toolName
        : llmToolName;
}

/**
 * 将 Cursor toolCall 类型映射到 execServerMessage 的 args 类型
 *
 * 返回 null 表示该工具无需 exec 通道 (Server 端或 Client 本地处理)
 */
export function mapToolToExecArgs(cursorToolType: string): string | null {
    return findToolByCursorType(cursorToolType)?.execArgsType ?? null;
}

/**
 * 构造 execServerMessage 的 args 对象
 *
 * 按 LLM 工具名（alias）查找构建函数，生成 Cursor 协议的 exec args。
 */
export function buildExecArgs(
    llmToolName: string,
    input: Record<string, unknown>,
    callId: string,
    options: ToolExecBuildOptions = {},
): Record<string, unknown> {
    const registered = buildRegisteredExecArgs(llmToolName, input, callId, options);
    if (registered) return registered;
    logger.warn({ llmToolName }, '[TOOL] unknown tool name for exec args');
    return { toolCallId: callId };
}

export function buildEditPlan(
    llmToolName: string,
    input: Record<string, unknown>,
    callId: string,
    options: ToolExecBuildOptions = {},
): EditPlan {
    const plan = buildRegisteredEditPlan(llmToolName, input, callId, options);
    if (plan) return plan;
    throw new Error(`Tool ${llmToolName} does not support edit plans`);
}

export function resolveToolCall(
    llmToolName: string,
    input: Record<string, unknown>,
    availableMcpTools: AvailableMcpTool[] = [],
    availableDynamicBuiltinTools: AvailableDynamicBuiltinTool[] = [],
): {
    cursorToolType: string
    sanitizedInput: Record<string, unknown>
    effectiveToolName?: string
    resolutionError?: string
} {
    const sanitizedInput = sanitizeToolInput(llmToolName, input);

    // dynamic namespace 模式: LLM 直接调 CallDynamicTool,自带
    // namespace + toolName + arguments (官方 LLM 侧参数名,实测 3.15.6)。
    // 这里把它映射成 McpArgs 需要的路由字段。
    //
    // namespace 的值官方用的是 serverIdentifier (如 user-ida-pro-mcp) ——
    // <dynamic_tools> 段里的 name 属性就是它。但也接受 serverName,
    // 因为 LLM 可能从 mcp_instructions 等处读到展示名。
    //
    // 解包走 parseDynamicInvoke —— 与 resolveExecutionToolName 共用,
    // 保证"分流判据"与"执行判据"永远一致。
    const dynamicInvoke = parseDynamicInvoke(llmToolName, input);
    if (dynamicInvoke) {
        const { namespace: server, toolName, args, invalidArgs: hasInvalidArgs } = dynamicInvoke;

        if (server === 'cursor') {
            if (hasInvalidArgs) {
                return {
                    cursorToolType: 'mcpToolCall',
                    sanitizedInput: {
                        name: `cursor-${toolName}`,
                        args: {},
                        providerIdentifier: 'cursor',
                        toolName,
                        serverIdentifier: 'cursor',
                    },
                    resolutionError: 'CallDynamicTool.arguments must be a JSON object.',
                };
            }
            const matchedBuiltin = availableDynamicBuiltinTools.find(tool => tool.tool === toolName);
            if (!matchedBuiltin) {
                logger.warn({
                    llmToolName,
                    namespace: server,
                    toolName,
                    knownDynamicBuiltins: availableDynamicBuiltinTools.map(tool => tool.tool),
                }, '[DYNAMIC-TOOLS] cursor tool not in dynamic registry');
                return {
                    cursorToolType: 'mcpToolCall',
                    sanitizedInput: {
                        name: `cursor-${toolName}`,
                        args,
                        providerIdentifier: 'cursor',
                        toolName,
                        serverIdentifier: 'cursor',
                    },
                    resolutionError: `Tool "${toolName}" was not found in namespace "cursor". Discover it with GetDynamicTools before invoking it.`,
                };
            }
            const cursorToolType = mapToolName(toolName);
            logger.debug({ llmToolName, namespace: server, toolName, cursorToolType },
                '[DYNAMIC-TOOLS] cursor native tool routed');
            return {
                cursorToolType,
                sanitizedInput: sanitizeToolInput(toolName, args),
                effectiveToolName: toolName,
            };
        }

        const matched = availableMcpTools.find(t =>
            t.toolName === toolName
            && (t.serverIdentifier === server || t.providerIdentifier === server));
        // 路由结果直接决定 McpArgs 发给哪个 server。matched=false 时走的是
        // "按 LLM 给的字面量硬发"这条兜底路径 —— 客户端很可能报 tool not found,
        // 所以单独记一条,便于把"名字对不上"和"MCP server 本身故障"区分开。
        logger[matched ? 'debug' : 'warn']({
            llmToolName,
            namespace: server,
            toolName,
            argKeys: Object.keys(args),
            routed: matched
                ? { name: matched.name, serverIdentifier: matched.serverIdentifier }
                : null,
            knownMcpTools: matched ? undefined : availableMcpTools.length,
        }, matched
            ? '[DYNAMIC-TOOLS] CallDynamicTool routed'
            : '[DYNAMIC-TOOLS] CallDynamicTool not in routing table — forwarding as-is');
        // 未匹配到也照发 —— 客户端 callTool 以 toolName 为准,serverIdentifier 仅作过滤器;
        // 宁可让客户端报 "tool not found",也好过我们这里静默吞掉调用。
        return {
            cursorToolType: 'mcpToolCall',
            sanitizedInput: {
                name: matched?.name ?? (server ? `${server}-${toolName}` : toolName),
                args,
                providerIdentifier: matched?.providerIdentifier ?? server,
                toolName,
                serverIdentifier: matched?.serverIdentifier ?? server,
            },
        };
    }

    const descriptor = availableMcpTools.find(tool => tool.name === llmToolName);

    if (descriptor && (descriptor.providerIdentifier || descriptor.toolName)) {
        return {
            cursorToolType: 'mcpToolCall',
            sanitizedInput: {
                name: llmToolName,
                args: sanitizedInput,
                providerIdentifier: descriptor.providerIdentifier ?? '',
                toolName: descriptor.toolName ?? '',
                serverIdentifier: descriptor.serverIdentifier ?? '',
            },
        };
    }

    // Dynamic profile 正常情况下不会走到这里;保留这条防御路径处理模型根据
    // Claude Code 训练惯例发出的 mcp__server__tool 名称。仍由客户端执行审批。
    const flat = parseFlatMcpToolName(llmToolName);
    if (flat) {
        const matched = resolveFlatMcpTool(flat, availableMcpTools);
        logger[matched ? 'debug' : 'warn']({
            llmToolName,
            server: flat.server,
            toolName: flat.toolName,
            routed: matched?.name ?? null,
        }, matched
            ? '[DYNAMIC-TOOLS] flat MCP name routed'
            : '[DYNAMIC-TOOLS] flat MCP name not in routing table — forwarding parsed values');
        return {
            cursorToolType: 'mcpToolCall',
            sanitizedInput: {
                name: matched?.name ?? llmToolName,
                args: sanitizedInput,
                providerIdentifier: matched?.providerIdentifier ?? flat.server,
                toolName: matched?.toolName ?? flat.toolName,
                serverIdentifier: matched?.serverIdentifier ?? flat.server,
            },
        };
    }

    return {
        cursorToolType: mapToolName(llmToolName),
        sanitizedInput,
    };
}
