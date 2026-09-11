/**
 * Dynamic Tools — GetDynamicTools 结果渲染
 *
 * 基础形状来自 Cursor 3.15.6 实测,并跟进 3.17.8 的状态/error 与大结果
 * outputFilePath 行为:
 *
 *   {"namespace":"x","toolName":"y"} → {mode:"single_tool", namespace, namespaceStatus, tool}
 *   {"namespace":"x"}                → {mode:"namespace",   namespace, namespaceStatus, tools[]}
 *   {"pattern":"re"}                 → {mode:"search",      pattern, matches[]}
 *   {}                               → {mode:"catalog",     namespaces[]}
 *
 * 两条关键差异 (照抄,勿"优化"):
 *   - inputSchema 只在 single_tool / namespace 出现;search / catalog 只给
 *     tool + description。对应 prompt 里 "namespace and single-tool lookups
 *     always return the complete description"。
 *   - search / catalog 的 description 超过 200 字符时截断为
 *     slice(0,185) + "... [truncated]",总长恰好 200。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpStateServerInfo, McpStateToolDefinition } from './mcpState';
import type { LLMTool } from '../llm/types';
import { findToolByAlias } from './toolRegistry';
import { assertSafeForServerFs } from './toolkit/pathUtils';

/** 截断后缀 — 实测原文,长度 15 */
const TRUNCATION_SUFFIX = '... [truncated]';
/** 3.17.8: 超过 200 字符才截断;保留 185 + 15 字符后缀。 */
const DESCRIPTION_LIMIT = 200;
const TRUNCATION_BODY_LIMIT = DESCRIPTION_LIMIT - TRUNCATION_SUFFIX.length;
/** 3.17.8 agent-exec 的 GetDynamicTools 大结果溢写阈值。 */
export const DYNAMIC_TOOLS_SPILL_THRESHOLD_BYTES = 12_000;
export const CURSOR_DYNAMIC_NAMESPACE = 'cursor';
export const CURSOR_DYNAMIC_NAMESPACE_DESCRIPTION = "Native Cursor tools for this session. These are highly recommended and useful tools that you should use when the right situation arises. Don't be afraid to look at one if it seems relevant, even if you don't end up using it. You MUST read the tool schemas before calling them.";

/** 对齐 dynamicToolProfile=final 的核心静态保护集合（按本项目 canonicalName 映射）。 */
const FINAL_PROFILE_STATIC_TOOLS = new Set([
    'AskQuestion',
    'ApplyPatch',
    'CreatePlan',
    'Edit',
    'Glob',
    'Grep',
    'Read',
    'Shell',
    'Write',
    'updateCurrentStep',
    // discovery/invocation meta tools 永远静态，防止形成递归发现。
    'GetDynamicTools',
    'CallDynamicTool',
    // MCP resource discovery itself must remain directly callable. Official
    // final-profile captures keep ListMcpResources static while exposing
    // FetchMcpResource through the reserved cursor namespace.
    'ListMcpResources',
]);

export interface CursorDynamicToolDefinition {
    tool: string;
    description: string;
    inputSchema: Record<string, unknown>;
    conciseStaticContext?: string;
}

const DYNAMIC_TOOL_CONCISE_CONTEXT: Record<string, string> = {
    TodoWrite: 'Use this tool to manage complex multi-step tasks.',
    ReadLints: 'Check for linter errors after substantive edits.',
    SwitchMode: 'Switch between available modes. Proactively consider switching modes for relevant requests.',
};

export function buildCursorNamespaceDescription(tools: CursorDynamicToolDefinition[]): string {
    const instructions = tools.flatMap(tool => tool.conciseStaticContext
        ? [`- ${tool.tool}: ${tool.conciseStaticContext}`]
        : []);
    return instructions.length === 0
        ? CURSOR_DYNAMIC_NAMESPACE_DESCRIPTION
        : [CURSOR_DYNAMIC_NAMESPACE_DESCRIPTION, '', 'Here are some crucial instructions:', ...instructions].join('\n');
}

export function shouldEnableBuiltinDynamicProfile(params: {
    clientSupportsDynamicTools: boolean;
    mcpMetaToolEnabled: boolean;
    previousDynamicToolCount?: number;
    isSubagent: boolean;
}): boolean {
    if (params.isSubagent)
        return false;
    return params.clientSupportsDynamicTools
        || params.mcpMetaToolEnabled
        || (params.previousDynamicToolCount ?? 0) > 0;
}

function normalizeDynamicBuiltinSchema(value: unknown): unknown {
    if (Array.isArray(value))
        return value.map(normalizeDynamicBuiltinSchema);
    if (!value || typeof value !== 'object')
        return value;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, nested]) => {
            if (key === 'type' && typeof nested === 'string'
                && ['OBJECT', 'STRING', 'NUMBER', 'INTEGER', 'BOOLEAN', 'ARRAY', 'NULL'].includes(nested)) {
                return [key, nested.toLowerCase()];
            }
            return [key, normalizeDynamicBuiltinSchema(nested)];
        }),
    );
}

export function partitionCursorBuiltinTools(
    tools: LLMTool[],
    enabled: boolean,
): { staticTools: LLMTool[]; dynamicTools: CursorDynamicToolDefinition[] } {
    if (!enabled)
        return { staticTools: tools, dynamicTools: [] };
    const staticTools: LLMTool[] = [];
    const dynamicTools: CursorDynamicToolDefinition[] = [];
    for (const tool of tools) {
        const canonicalName = findToolByAlias(tool.name)?.canonicalName ?? tool.name;
        if (FINAL_PROFILE_STATIC_TOOLS.has(canonicalName)) {
            staticTools.push(tool);
            continue;
        }
        dynamicTools.push({
            tool: tool.name,
            description: tool.description,
            inputSchema: normalizeDynamicBuiltinSchema(tool.inputSchema) as Record<string, unknown>,
            ...(DYNAMIC_TOOL_CONCISE_CONTEXT[canonicalName]
                ? { conciseStaticContext: DYNAMIC_TOOL_CONCISE_CONTEXT[canonicalName] }
                : {}),
        });
    }
    dynamicTools.sort((left, right) => left.tool.localeCompare(right.tool));
    return { staticTools, dynamicTools };
}

export function contextualizeDynamicMetaTools(
    tools: LLMTool[],
    dynamicTools: CursorDynamicToolDefinition[],
): LLMTool[] {
    if (dynamicTools.length === 0)
        return tools;
    const names = dynamicTools.map(tool => tool.tool).join(', ');
    return tools.map((tool) => {
        if (tool.name === 'GetDynamicTools') {
            return {
                ...tool,
                description: `${tool.description}\n\nFirst-party Cursor tools: the reserved namespace "cursor" lists built-in Cursor tools available on demand (${names}). Discover their schemas here, then invoke them via CallDynamicTool; they run natively with their own approvals and rendering.`,
            };
        }
        if (tool.name === 'CallDynamicTool') {
            return {
                ...tool,
                description: `${tool.description}\n\nTools in the reserved "cursor" namespace run as native Cursor tools with their original approvals and result rendering.`,
            };
        }
        return tool;
    });
}

export function toCursorDynamicNamespace(tools: CursorDynamicToolDefinition[]): DynamicNamespace | null {
    if (tools.length === 0)
        return null;
    return {
        name: CURSOR_DYNAMIC_NAMESPACE,
        source: 'cursor',
        description: buildCursorNamespaceDescription(tools),
        tools: tools.map(tool => ({
            tool: tool.tool,
            description: tool.description,
            inputSchema: tool.inputSchema,
        })),
    };
}

/**
 * search / catalog 模式的 description 裁剪。
 * 未超限时原样返回(不追加后缀)。
 */
export function shortenDescription(description: string): string {
    if (description.length <= DESCRIPTION_LIMIT)
        return description;
    return description.slice(0, TRUNCATION_BODY_LIMIT) + TRUNCATION_SUFFIX;
}

/**
 * 服务端自动追加的认证工具。
 *
 * 实测: requestContext.supports_mcp_auth = true 时,每个 MCP namespace 的
 * tools 末尾都会多出这一项 —— 它**不在**客户端下发的 descriptor 里,
 * 由服务端凭空补上。
 */
export const MCP_AUTH_TOOL = {
    tool: 'mcp_auth',
    description: 'Authenticate this MCP server so its tools can be used.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
} as const;

export interface DynamicToolsQuery {
    /** LLM 侧参数名是 namespace,proto 侧字段名是 server */
    namespace?: string;
    toolName?: string;
    pattern?: string;
}

/** 同时接受 3.17 dynamic profile 与旧 meta-MCP profile 的参数名。 */
export function parseDynamicToolsQuery(input: Record<string, unknown>): DynamicToolsQuery {
    const namespace = typeof input.namespace === 'string' && input.namespace
        ? input.namespace
        : typeof input.server === 'string' && input.server
            ? input.server
            : undefined;
    const toolName = typeof input.toolName === 'string' && input.toolName
        ? input.toolName
        : typeof input.tool_name === 'string' && input.tool_name
            ? input.tool_name
            : undefined;
    return {
        namespace,
        toolName,
        pattern: typeof input.pattern === 'string' && input.pattern ? input.pattern : undefined,
    };
}

export function validateDynamicToolsQuery(query: DynamicToolsQuery): string | undefined {
    if (query.toolName && !query.namespace)
        return 'toolName requires namespace to be set.';
    if (!query.pattern)
        return undefined;
    if (query.pattern.length > 256)
        return 'pattern cannot exceed 256 characters.';
    try {
        RegExp(query.pattern);
        return undefined;
    }
    catch (error) {
        return `Invalid regex pattern: ${error instanceof Error ? error.message : String(error)}`;
    }
}

/** 一个可被 discovery 的 namespace */
export interface DynamicNamespace {
    name: string;
    source: 'mcp' | 'cursor';
    /** MCP namespace 状态;3.17.8 客户端常回 connected,模型侧应看到 ready。 */
    status?: string;
    /** McpStateServer.error_message (3.17.8 field 8)。 */
    error?: string;
    /** namespace 使用说明/描述;MCP 与 cursor namespace 均可携带。 */
    description?: string;
    tools: Array<{ tool: string; description: string; inputSchema: Record<string, unknown> }>;
}

export function normalizeDynamicNamespaceStatus(status: string | undefined): string {
    const normalized = status?.trim();
    return !normalized || normalized === 'connected' ? 'ready' : normalized;
}

/** 把 mcpState 拉回的 server 转成 namespace;supportsMcpAuth 时补 mcp_auth */
export function toDynamicNamespace(
    server: McpStateServerInfo,
    supportsMcpAuth: boolean,
): DynamicNamespace {
    const tools = server.tools.map((t: McpStateToolDefinition) => ({
        tool: t.toolName,
        description: t.description,
        inputSchema: t.inputSchema,
    }));
    if (supportsMcpAuth && !tools.some(tool => tool.tool === MCP_AUTH_TOOL.tool)) {
        tools.push({
            ...MCP_AUTH_TOOL,
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        });
    }
    return {
        name: server.serverIdentifier,
        source: 'mcp',
        status: normalizeDynamicNamespaceStatus(server.status),
        ...(server.errorMessage ? { error: server.errorMessage } : {}),
        ...(server.instructions ? { description: server.instructions } : {}),
        tools,
    };
}

/** 供 namespace / single_tool 使用的完整工具形状 */
function fullTool(t: DynamicNamespace['tools'][number]) {
    return { tool: t.tool, description: t.description, inputSchema: t.inputSchema };
}

/** 供 search / catalog 使用的精简工具形状 —— 无 inputSchema,description 截断 */
function slimTool(t: DynamicNamespace['tools'][number]) {
    return { tool: t.tool, description: shortenDescription(t.description) };
}

/**
 * namespace 元信息 —— MCP 带 namespaceStatus/error,两类 namespace 都可带
 * namespaceDescription (3.17.8 用 server instructions 生成)。
 */
function namespaceMeta(
    ns: DynamicNamespace,
    descriptionDetail: 'full' | 'short' = 'full',
): Record<string, unknown> {
    const description = ns.description
        ? (descriptionDetail === 'short' ? shortenDescription(ns.description) : ns.description)
        : undefined;
    return ns.source === 'cursor'
        ? (description ? { namespaceDescription: description } : {})
        : {
            namespaceStatus: normalizeDynamicNamespaceStatus(ns.status),
            ...(ns.error ? { namespaceError: ns.error } : {}),
            ...(description ? { namespaceDescription: description } : {}),
        };
}

/**
 * 渲染 GetDynamicTools 的返回体。
 *
 * @param namespaces 本次查询范围内、已取回完整 schema 的 namespace
 */
export function renderDynamicToolsResult(
    query: DynamicToolsQuery,
    namespaces: DynamicNamespace[],
): Record<string, unknown> {
    const { namespace, toolName, pattern } = query;

    // 模式 3/4: pattern 搜索 (无 namespace 限定则跨全部 namespace)
    if (pattern !== undefined && pattern !== '') {
        let regex: RegExp;
        try {
            regex = new RegExp(pattern, 'i');
        }
        catch {
            // 非法正则退化为字面量子串匹配,不让 LLM 因写错正则而卡死
            const literal = pattern.toLowerCase();
            regex = { test: (s: string) => s.toLowerCase().includes(literal) } as RegExp;
        }
        const scope = (namespace ? namespaces.filter(n => n.name === namespace) : namespaces)
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name));
        const matches: Array<Record<string, unknown>> = [];
        for (const ns of scope) {
            const namespaceMatches = regex.test(ns.name);
            const status = normalizeDynamicNamespaceStatus(ns.status);
            if (namespaceMatches) {
                // 3.17.8 会先返回一条 namespace 自身的 match,因此没有工具的
                // needsAuth/error namespace 也能被发现。
                matches.push({
                    namespace: ns.name,
                    ...(ns.description ? { description: shortenDescription(ns.description) } : {}),
                    ...(ns.source === 'mcp'
                        ? {
                            namespaceStatus: status,
                            ...(ns.error ? { namespaceError: ns.error } : {}),
                        }
                        : {}),
                });
            }
            for (const t of [...ns.tools].sort((a, b) => a.tool.localeCompare(b.tool))) {
                // 正常 ready tool match 不重复附状态;异常 namespace 才携带状态。
                // 当 namespace 名本身命中时,状态已在上方 namespace-only entry 中。
                if (regex.test(t.tool) || namespaceMatches) {
                    matches.push({
                        namespace: ns.name,
                        ...slimTool(t),
                        ...(!namespaceMatches && ns.source === 'mcp' && status !== 'ready'
                            ? {
                                namespaceStatus: status,
                                ...(ns.error ? { namespaceError: ns.error } : {}),
                            }
                            : {}),
                    });
                }
            }
        }
        return { mode: 'search', pattern, matches };
    }

    if (namespace) {
        const ns = namespaces.find(n => n.name === namespace);
        if (!ns) {
            return {
                mode: toolName ? 'single_tool' : 'namespace',
                namespace,
                namespaceStatus: 'not_found',
                error: `Namespace "${namespace}" was not found.`,
            };
        }

        // 模式 2: 单工具
        if (toolName) {
            const t = ns.tools.find(x => x.tool === toolName);
            if (!t) {
                return {
                    mode: 'single_tool',
                    namespace,
                    ...namespaceMeta(ns),
                    error: `Tool "${toolName}" was not found in namespace "${namespace}".`,
                };
            }
            return { mode: 'single_tool', namespace, ...namespaceMeta(ns), tool: fullTool(t) };
        }

        // 模式 1: 整个 namespace
        return {
            mode: 'namespace',
            namespace,
            ...namespaceMeta(ns),
            tools: [...ns.tools].sort((a, b) => a.tool.localeCompare(b.tool)).map(fullTool),
        };
    }

    // 模式 5: 无参数 → 全量 catalog (精简)
    return {
        mode: 'catalog',
        namespaces: [...namespaces]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(ns => ({
                namespace: ns.name,
                ...namespaceMeta(ns, 'short'),
                tools: [...ns.tools].sort((a, b) => a.tool.localeCompare(b.tool)).map(slimTool),
            })),
    };
}

export interface SerializedDynamicToolsResult {
    content: string;
    outputFilePath?: string;
    payloadBytes: number;
    wroteToFile: boolean;
}

/**
 * 序列化 discovery 结果,并对齐 3.17.8 的大结果溢写行为。
 *
 * projectDir 缺失时保持内联;写盘失败由调用方记录并降级为内联结果。
 */
export async function serializeDynamicToolsResult(
    result: Record<string, unknown>,
    options: { projectDir?: string; spillThresholdBytes?: number } = {},
): Promise<SerializedDynamicToolsResult> {
    const payload = JSON.stringify(result, null, 2);
    const payloadBytes = Buffer.byteLength(payload, 'utf8');
    const threshold = options.spillThresholdBytes ?? DYNAMIC_TOOLS_SPILL_THRESHOLD_BYTES;
    const projectDir = options.projectDir?.trim();
    if (!projectDir || payloadBytes <= threshold) {
        return { content: payload, payloadBytes, wroteToFile: false };
    }

    // Validate before join() can normalize away a leading UNC separator.
    assertSafeForServerFs(projectDir, 'Dynamic tool result spill');
    const outputDir = join(projectDir, 'agent-tools');
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
    const outputFilePath = join(outputDir, `${randomUUID()}.txt`);
    await writeFile(outputFilePath, payload, { encoding: 'utf8', mode: 0o600 });
    const lineCount = payload.split('\n').length;
    const size = payloadBytes >= 1024
        ? `${(payloadBytes / 1024).toFixed(1)} KB`
        : `${payloadBytes} bytes`;
    const content = JSON.stringify({
        note: `Large output has been written to: ${outputFilePath} (${size}, ${lineCount} lines)`,
        filePath: outputFilePath,
    }, null, 2);
    return { content, outputFilePath, payloadBytes, wroteToFile: true };
}

/**
 * 生成 preamble 里的 <dynamic_tools> 段。
 *
 * 正文逐字来自官方实测 (analysis/mcp-dynamic-tools.md §3)。namespace 列表
 * 由 mcpDescriptors 生成 —— name 必须用 serverIdentifier 而非 serverName。
 *
 * MCP 与保留的 cursor namespace 共用同一目录；cursor 项由 final profile
 * 中隐藏的原生工具生成，调用时仍回到原审批与执行链路。
 */
export interface DynamicToolCatalogEntry {
    serverIdentifier: string;
    toolNames: string[];
    serverUseInstructions?: string;
    source?: 'mcp' | 'cursor';
}

export function buildDynamicToolCatalogEntries(parsed: {
    mcpMetaTool?: {
        enabled: boolean;
        descriptors: Array<{
            serverIdentifier: string;
            serverUseInstructions?: string;
            tools: Array<{ toolName: string }>;
        }>;
    };
    cursorDynamicTools: CursorDynamicToolDefinition[];
}): DynamicToolCatalogEntry[] {
    const entries: DynamicToolCatalogEntry[] = [];
    const hasCursorNamespace = parsed.cursorDynamicTools.length > 0;
    if (parsed.mcpMetaTool?.enabled) {
        for (const descriptor of parsed.mcpMetaTool.descriptors) {
            if (hasCursorNamespace && descriptor.serverIdentifier === CURSOR_DYNAMIC_NAMESPACE)
                continue;
            entries.push({
                serverIdentifier: descriptor.serverIdentifier,
                toolNames: descriptor.tools.map(tool => tool.toolName),
                ...(descriptor.serverUseInstructions
                    ? { serverUseInstructions: descriptor.serverUseInstructions }
                    : {}),
                source: 'mcp',
            });
        }
    }
    if (parsed.cursorDynamicTools.length > 0) {
        entries.push({
            serverIdentifier: CURSOR_DYNAMIC_NAMESPACE,
            toolNames: parsed.cursorDynamicTools.map(tool => tool.tool),
            serverUseInstructions: buildCursorNamespaceDescription(parsed.cursorDynamicTools),
            source: 'cursor',
        });
    }
    return entries;
}

export function buildDynamicToolsSection(
    servers: DynamicToolCatalogEntry[],
    supportsMcpAuth: boolean,
): string {
    const entries = servers.map((s) => {
        const source = s.source ?? 'mcp';
        const tools = source === 'mcp' && supportsMcpAuth && !s.toolNames.includes(MCP_AUTH_TOOL.tool)
            ? [...s.toolNames, MCP_AUTH_TOOL.tool]
            : s.toolNames;
        const attrs = [
            `name="${escapeXmlAttr(s.serverIdentifier)}"`,
            `tools="${escapeXmlAttr(tools.join(', '))}"`,
        ];
        if (s.serverUseInstructions)
            attrs.push(`namespaceUseInstructions="${escapeXmlAttr(s.serverUseInstructions)}"`);
        attrs.push(`source="${source}"`);
        return `<namespace ${attrs.join(' ')} />`;
    });

    const hasMcpNamespaces = servers.some(server => (server.source ?? 'mcp') === 'mcp');
    const authNote = supportsMcpAuth && hasMcpNamespaces
        ? `\n\nIf an MCP-backed namespace requires authentication, call \`mcp_auth\` through \`CallDynamicTool\` for that namespace, then inspect it again and retry if appropriate. Do not authenticate namespaces preemptively or repeatedly.`
        : '';

    return `
<dynamic_tools>
You have access to tools through dynamic namespaces, e.g. MCP servers, using \`GetDynamicTools\` and \`CallDynamicTool\`.

## Dynamic Tool Discovery and Invocation

Use \`GetDynamicTools\` to discover tool schemas, then \`CallDynamicTool\` to invoke one tool. Aim to minimize round-trips: ideally one discovery call followed by one invocation.

If the user mentions a product or service represented by an available namespace, and the request likely depends on it, proactively inspect that namespace before answering. If you are unsure which namespace matches, search with a relevant pattern.

\`GetDynamicTools\` supports these modes:

1. \`{"namespace":"<id>"}\`: returns schemas and full descriptions for every tool in that namespace.
2. \`{"namespace":"<id>","toolName":"<name>"}\`: returns one tool schema with its full description.
3. \`{"pattern":"<regex>"}\`: searches namespace and tool names.
4. \`{"namespace":"<id>","pattern":"<regex>"}\`: searches tools within one namespace.
5. No arguments: returns the full catalog.

Pattern-search and catalog results shorten long descriptions, marked by a trailing "${TRUNCATION_SUFFIX}"; namespace and single-tool lookups always return the complete description.

Always inspect a tool's schema before invoking it with \`CallDynamicTool\`.

If the available dynamic tools do not fully support what the user asked you to do, complete the work you can with the current tool set. In your work summary, include what you were unable to do and why. Do not use browser automation to work around missing tools unless the user explicitly asks you to use the browser.


Available dynamic tool namespaces:

<dynamic_tool_namespaces>
${entries.join('\n')}
</dynamic_tool_namespaces>${authNote}
</dynamic_tools>`;
}

function escapeXmlAttr(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
