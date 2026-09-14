import type { LLMTool } from '../../llm/types';
import type { ProviderType } from '../../../data/defaults';
import type { EditPlan } from './editPlans';
import type { ToolExecBuildOptions, ToolRegistryEntry } from './types';
import { toProviderFamily } from './types';

// ── 逐工具导入 ──
import { ShellTool } from './definitions/Shell';
import { GlobTool } from './definitions/Glob';
import { GrepTool } from './definitions/Grep';
import { AwaitTool } from './definitions/Await';
import { ReadTool } from './definitions/Read';
import { DeleteTool } from './definitions/Delete';
import { EditTool } from './definitions/Edit';
import { WriteTool } from './definitions/Write';
import { EditNotebookTool } from './definitions/EditNotebook';
import { TodoWriteTool } from './definitions/TodoWrite';
import { ReadLintsTool } from './definitions/ReadLints';
import { WebSearchTool } from './definitions/WebSearch';
import { WebFetchTool } from './definitions/WebFetch';
import { GenerateImageTool } from './definitions/GenerateImage';
import { AskQuestionTool } from './definitions/AskQuestion';
import { TaskTool } from './definitions/Task';
import { ListMcpResourcesTool } from './definitions/ListMcpResources';
import { FetchMcpResourceTool } from './definitions/FetchMcpResource';
import { SwitchModeTool } from './definitions/SwitchMode';
import { CallMcpToolTool } from './definitions/CallMcpTool';
import { GetDynamicToolsTool } from './definitions/GetDynamicTools';
import { ApplyPatchTool } from './definitions/ApplyPatch';
import { CreatePlanTool } from './definitions/CreatePlan';
import { UpdateCurrentStepTool } from './definitions/UpdateCurrentStep';
import { CreateGoalTool } from './definitions/CreateGoal';
import { UpdateGoalTool } from './definitions/UpdateGoal';
// SemanticSearch 暂不注册 — BYOK server 无 retrieval 后端,
// 下发给 LLM 只会产生无意义的工具调用。待实现 retrieval 服务后恢复。
// import { SemanticSearchTool } from './definitions/SemanticSearch';

// 顺序对齐官方 Server (Haiku + Gemini 双提取验证)
const TOOL_REGISTRY: ToolRegistryEntry[] = [
    UpdateCurrentStepTool,
    ShellTool,
    GlobTool,
    GrepTool,
    AwaitTool,
    ReadTool,
    DeleteTool,
    EditTool,
    ApplyPatchTool,
    WriteTool,
    EditNotebookTool,
    TodoWriteTool,
    ReadLintsTool,
    WebSearchTool,
    WebFetchTool,
    GenerateImageTool,
    AskQuestionTool,
    TaskTool,
    ListMcpResourcesTool,
    FetchMcpResourceTool,
    SwitchModeTool,
    CallMcpToolTool,
    GetDynamicToolsTool,
    CreatePlanTool,
    CreateGoalTool,
    UpdateGoalTool,
    // SemanticSearchTool,
];

export function listRegisteredTools(): ToolRegistryEntry[] {
    return TOOL_REGISTRY;
}

/**
 * 按 provider 返回该 provider 应暴露给 LLM 的工具定义列表。
 * 每个 ToolRegistryEntry.llmToolByProvider 中未包含该 provider 族的工具将被过滤。
 */
export function listBuiltinLlmTools(provider: ProviderType): LLMTool[] {
    const family = toProviderFamily(provider);
    return TOOL_REGISTRY.flatMap(entry => {
        const tool = entry.llmToolByProvider[family];
        return tool ? [tool] : [];
    });
}

export function findToolByAlias(name: string): ToolRegistryEntry | undefined {
    return TOOL_REGISTRY.find(entry => entry.aliases.includes(name));
}

export function findToolByCursorType(cursorToolType: string): ToolRegistryEntry | undefined {
    return TOOL_REGISTRY.find(entry => entry.cursorToolType === cursorToolType);
}

/**
 * 按 LLM 工具名（alias）查找 buildStartedArgs。
 * 不能用 cursorToolType 查找，因为 Edit 和 Write 共享 editToolCall。
 *
 * MCP 工具: 工具名是动态的 (如 "cursor-ide-browser-browser_navigate"),
 * 不在任何 entry 的 aliases 里。resolveToolCall 已识别并在 input 中标记了
 * providerIdentifier,这里据此路由到 CallMcpTool 的 builder。
 */
export function buildRegisteredToolArgs(
    llmToolName: string,
    input: Record<string, unknown>,
    callId: string,
    options: ToolExecBuildOptions = {},
): Record<string, unknown> | null {
    const entry = findToolByAlias(llmToolName);
    if (entry?.buildStartedArgs) return entry.buildStartedArgs(input, callId, options);

    if (typeof input.providerIdentifier === 'string' && input.providerIdentifier) {
        return findToolByCursorType('mcpToolCall')?.buildStartedArgs?.(input, callId, options) ?? null;
    }

    return null;
}

/**
 * 按 LLM 工具名（alias）查找 buildExecArgs。
 * MCP 工具同上,通过 providerIdentifier 路由到 CallMcpTool。
 */
export function buildRegisteredExecArgs(
    llmToolName: string,
    input: Record<string, unknown>,
    callId: string,
    options: ToolExecBuildOptions = {},
): Record<string, unknown> | null {
    const entry = findToolByAlias(llmToolName);
    if (entry?.buildExecArgs) return entry.buildExecArgs(input, callId, options);

    if (typeof input.providerIdentifier === 'string' && input.providerIdentifier) {
        return findToolByCursorType('mcpToolCall')?.buildExecArgs?.(input, callId, options) ?? null;
    }

    return null;
}

export function buildRegisteredEditPlan(
    llmToolName: string,
    input: Record<string, unknown>,
    callId: string,
    options: ToolExecBuildOptions = {},
): EditPlan | null {
    const entry = findToolByAlias(llmToolName);
    return entry?.buildEditPlan?.(input, callId, options) ?? null;
}
