import { logger } from '../../logger';
import {
    buildFileExecToolResult,
    buildFileToolResultText,
    normalizeFileToolResult,
} from './toolkit/results/fileToolResults';
import {
    buildAskQuestionResultFromInteractionResponse,
    buildInteractionToolResultText,
    buildLocalInteractionToolResult,
    buildWebFetchApprovalResultFromInteractionResponse,
    buildWebSearchApprovalResultFromInteractionResponse,
    normalizeInteractionToolResult,
} from './toolkit/results/interactionToolResults';
import {
    buildMcpExecToolResult,
    buildMcpToolResultText,
    normalizeMcpToolResult,
} from './toolkit/results/mcpToolResults';
import {
    buildSearchExecToolResult,
    buildSearchToolResultText,
    normalizeSearchToolResult,
} from './toolkit/results/searchToolResults';
import {
    buildAwaitExecToolResult,
    buildAwaitToolResultText,
    normalizeAwaitToolResult,
} from './toolkit/results/awaitToolResults';
import {
    buildShellToolResult,
    buildShellToolResultText,
    normalizeShellToolResult,
} from './toolkit/results/shellToolResults';
import {
    buildTaskExecToolResult,
    buildTaskToolResultText,
    normalizeTaskToolResult,
    type TaskEntryTruncationContext,
} from './toolkit/results/taskToolResults';
import { obj, str, truncate, type ToolResultEnvelope } from './toolkit/results/shared';

export type { ToolResultEnvelope } from './toolkit/results/shared';
export {
    buildAskQuestionResultFromInteractionResponse,
    buildShellToolResult,
    buildWebFetchApprovalResultFromInteractionResponse,
    buildWebSearchApprovalResultFromInteractionResponse,
};

export function buildExecToolResult(
    cursorToolType: string,
    execClientMsg: Record<string, unknown>,
    input: Record<string, unknown>,
): ToolResultEnvelope {
    try {
        return buildSearchExecToolResult(cursorToolType, execClientMsg, input)
            ?? buildFileExecToolResult(cursorToolType, execClientMsg, input)
            ?? buildAwaitExecToolResult(cursorToolType, execClientMsg, input)
            ?? (cursorToolType === 'taskToolCall' ? buildTaskExecToolResult(execClientMsg) : null)
            ?? buildMcpExecToolResult(cursorToolType, execClientMsg, input)
            ?? { result: { case: 'error', value: { message: `unsupported exec tool ${cursorToolType}` } } };
    } catch (e) {
        logger.warn({ cursorToolType, error: (e as Error).message }, '[TOOL] buildExecToolResult error');
        return { result: { case: 'error', value: { message: (e as Error).message } } };
    }
}

export function buildLocalToolResult(cursorToolType: string, input: Record<string, unknown>): ToolResultEnvelope {
    return buildLocalInteractionToolResult(cursorToolType, input)
        ?? { result: { case: 'error', value: { message: `unsupported local tool ${cursorToolType}` } } };
}

export function normalizeToolResult(
    cursorToolType: string,
    toolResult: ToolResultEnvelope,
    input: Record<string, unknown>,
): ToolResultEnvelope {
    const resultCaseName = str(toolResult.result?.case);
    const value = obj(toolResult.result?.value);

    return normalizeSearchToolResult(cursorToolType, resultCaseName, value, input)
        ?? normalizeInteractionToolResult(cursorToolType, resultCaseName, value, input)
        ?? normalizeFileToolResult(cursorToolType, resultCaseName, value, input)
        ?? normalizeAwaitToolResult(cursorToolType, resultCaseName, value)
        ?? (cursorToolType === 'taskToolCall' ? normalizeTaskToolResult(resultCaseName, value) : null)
        ?? (cursorToolType === 'communicateUpdateToolCall' ? { result: { case: resultCaseName || 'success', value } } : null)
        ?? normalizeMcpToolResult(cursorToolType, resultCaseName, value, input)
        ?? (cursorToolType === 'shellToolCall' ? normalizeShellToolResult(resultCaseName, value, input) : null)
        ?? { result: { case: resultCaseName || 'error', value } };
}

export function isToolResultError(toolResult: ToolResultEnvelope): boolean {
    const result = obj(toolResult.result);
    switch (str(result.case)) {
        case 'error':
        case 'failure':
        case 'rejected':
        case 'permissionDenied':
        case 'writePermissionDenied':
            return true;
        default:
            return false;
    }
}

export function buildToolResultText(
    cursorToolType: string,
    toolResult: ToolResultEnvelope,
    input: Record<string, unknown>,
    entryTruncation?: TaskEntryTruncationContext,
): string {
    const result = obj(toolResult.result);
    const resultCaseName = str(result.case);
    const value = obj(result.value);

    return (cursorToolType === 'shellToolCall' ? buildShellToolResultText(resultCaseName, value, input) : null)
        ?? buildAwaitToolResultText(cursorToolType, resultCaseName, value)
        ?? buildSearchToolResultText(cursorToolType, resultCaseName, value, input)
        ?? buildFileToolResultText(cursorToolType, resultCaseName, value, input)
        ?? buildInteractionToolResultText(cursorToolType, toolResult, resultCaseName, value)
        ?? (cursorToolType === 'taskToolCall' ? buildTaskToolResultText(resultCaseName, value, entryTruncation) : null)
        ?? (cursorToolType === 'communicateUpdateToolCall' ? 'Progress update recorded.' : null)
        ?? buildMcpToolResultText(cursorToolType, resultCaseName, value)
        ?? truncate(JSON.stringify(toolResult, null, 2), 12000);
}
