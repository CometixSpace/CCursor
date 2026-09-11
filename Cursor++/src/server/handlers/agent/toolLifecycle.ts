import type { AgentServerMessage } from '../../gen/agent_v1_pb';
import type { ProviderRoundContext } from '../llm/providerRuntime';
import type { ReadContextState } from './contextCatalog';
import { collectReadContextAttachments, cursorRuleToProtoInit } from './contextCatalog';
import type { LLMContentBlock, LLMMessage } from '../llm/types';
import { toolCallCompleted } from './stream';
import type { TaskEntryTruncationContext } from './toolkit/results/taskToolResults';
import {
    buildToolResultText,
    isToolResultError,
    normalizeToolResult,
    type ToolResultEnvelope,
} from './toolResults';

const IMAGE_EXTENSIONS: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif',
};

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB

function extractReadImageBlock(cursorToolType: string, toolResult: ToolResultEnvelope, input: Record<string, unknown>): Extract<LLMContentBlock, { type: 'image' }> | null {
    if (cursorToolType !== 'readToolCall') return null;
    const value = toolResult.result?.value as Record<string, unknown> | undefined;
    if (!value || toolResult.result?.case !== 'success') return null;
    const output = value.output as { case: string; value: unknown } | undefined;
    if (output?.case !== 'data' || !(output.value instanceof Uint8Array)) return null;
    const bytes = output.value as Uint8Array;
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_SIZE) return null;
    const path = String(value.path ?? input.path ?? '');
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
    const mimeType = IMAGE_EXTENSIONS[ext];
    if (!mimeType) return null;
    return { type: 'image', mimeType, data: Buffer.from(bytes).toString('base64') };
}

export function finalizeToolCall(params: {
    roundContext: Pick<ProviderRoundContext, 'createToolResult' | 'recordToolResult'>;
    messages: LLMMessage[];
    cursorToolType: string;
    toolName: string;
    callId: string;
    startedArgs: Record<string, unknown>;
    rawToolResult: ToolResultEnvelope;
    input: Record<string, unknown>;
    modelCallId: string;
    readContext?: ReadContextState;
    /** Task 报告入口截断上下文 (conversationId + 窗口) — 仅 Task 路径需要 */
    entryTruncation?: TaskEntryTruncationContext;
}): { toolResult: ToolResultEnvelope; resultText: string; frame: AgentServerMessage; imageBlock: Extract<LLMContentBlock, { type: 'image' }> | null } {
    const toolResult = normalizeToolResult(params.cursorToolType, params.rawToolResult, params.input);
    let relatedSkills: ReturnType<typeof collectReadContextAttachments>['skills'] = [];
    if (params.cursorToolType === 'readToolCall'
        && params.readContext
        && toolResult.result?.case === 'success') {
        const success = toolResult.result.value as Record<string, unknown>;
        const readPath = String(success.path ?? params.input.path ?? '');
        if (readPath) {
            const attachments = collectReadContextAttachments(params.readContext, readPath);
            relatedSkills = attachments.skills;
            const existingRules = Array.isArray(success.relatedCursorRules)
                ? success.relatedCursorRules as Array<Record<string, unknown>>
                : [];
            const existingPaths = new Set(existingRules.map(rule => String(rule.fullPath ?? '')));
            const newRules = attachments.rules
                .filter(rule => !existingPaths.has(rule.fullPath))
                .map(cursorRuleToProtoInit);
            if (existingRules.length > 0 || newRules.length > 0) {
                success.relatedCursorRules = [...existingRules, ...newRules];
                success.relatedCursorRulePaths = [...new Set(
                    [...existingRules, ...newRules].map(rule => String(rule.fullPath ?? '')).filter(Boolean),
                )];
            }
        }
    }

    let resultText = buildToolResultText(params.cursorToolType, toolResult, params.input, params.entryTruncation);
    if (params.cursorToolType === 'readToolCall' && toolResult.result?.case === 'success') {
        const success = toolResult.result.value as Record<string, unknown>;
        const relatedRules = Array.isArray(success.relatedCursorRules)
            ? success.relatedCursorRules as Array<Record<string, unknown>>
            : [];
        if (relatedRules.length > 0) {
            const renderedRules = relatedRules.map((rule) => {
                const content = typeof rule.content === 'string' && rule.content.trimEnd()
                    ? rule.content.trimEnd()
                    : '(Rule file is empty.)';
                return `- ${String(rule.fullPath || '(unknown rule path)')}\n${content}`;
            });
            resultText += `\n\nThe following cursor rule files are relevant to the files you just read:\n\n${renderedRules.join('\n\n')}\n\nConsider these rules if they affect your changes.`;
        }
        if (relatedSkills.length > 0) {
            const renderedSkills = relatedSkills.map(skill => `- ${skill.fullPath}\n${skill.description || '(No description)'}`);
            resultText += `\n\nThe following skills may be relevant to the files you just read:\n\n${renderedSkills.join('\n\n')}`;
        }
    }
    const isError = isToolResultError(toolResult);

    if (isError) {
        resultText += '\n\nPlease re-read the tool definition to understand the expected parameters before retrying.';
    }

    params.roundContext.recordToolResult(
        params.messages,
        params.roundContext.createToolResult({
            toolCallId: params.callId,
            toolName: params.toolName,
            content: resultText,
            isError,
        }),
    );

    return {
        toolResult,
        resultText,
        frame: toolCallCompleted(
            params.callId,
            params.cursorToolType,
            params.startedArgs,
            toolResult,
            params.modelCallId,
        ),
        imageBlock: extractReadImageBlock(params.cursorToolType, toolResult, params.input),
    };
}
