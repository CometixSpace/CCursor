import { str } from '../shared';
import type { ToolRegistryEntry } from '../types';

/**
 * SemanticSearch — 语义搜索工具
 *
 * Proto: semSearchToolCall (field 16)
 * Args: SemSearchToolArgs { query, target_directories[], explanation }
 * Result: SemSearchToolSuccess { results (XML string), code_results (bytes[]) }
 *
 * 客户端使用本地嵌入索引执行语义搜索，返回匹配的代码片段。
 * 搜索结果以 <search_result> XML 格式返回。
 * 无专用 exec channel — 客户端直接在 toolCallCompleted 中返回结果。
 */

const DESCRIPTION = `Search the codebase semantically. Use this when you want to find code by meaning rather than exact text matching. Returns relevant code snippets ranked by semantic similarity to your query.

Usage:
- Provide a natural language query describing what you're looking for
- Optionally specify target directories to narrow the search scope
- Results include file paths, line numbers, and code content
- Use this instead of Grep when you don't know the exact symbols or strings to search for`;

const ANTHROPIC = {
    name: 'SemanticSearch',
    description: DESCRIPTION,
    inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
            query: {
                type: 'string',
                description: 'Natural language search query describing what you are looking for.',
            },
            target_directories: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional list of absolute directory paths to search within. If not provided, searches the entire workspace.',
            },
            explanation: {
                type: 'string',
                description: 'Optional explanation for why this search is being performed.',
            },
        },
    },
};

const OPENAI = {
    name: 'SemanticSearch',
    description: DESCRIPTION,
    inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
            query: {
                type: 'string',
                description: 'Natural language search query describing what you are looking for.',
            },
            target_directories: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional list of absolute directory paths to search within.',
            },
            explanation: {
                type: 'string',
                description: 'Optional explanation for why this search is being performed.',
            },
        },
    },
};

const GEMINI = {
    name: 'SemanticSearch',
    description: DESCRIPTION,
    inputSchema: {
        type: 'OBJECT',
        required: ['query'],
        properties: {
            query: {
                type: 'STRING',
                description: 'Natural language search query describing what you are looking for.',
            },
            target_directories: {
                type: 'ARRAY',
                items: { type: 'STRING' },
                description: 'Optional list of absolute directory paths to search within.',
            },
            explanation: {
                type: 'STRING',
                description: 'Optional explanation for why this search is being performed.',
            },
        },
    },
};

export const SemanticSearchTool: ToolRegistryEntry = {
    canonicalName: 'SemanticSearch',
    aliases: ['SemanticSearch'],
    cursorToolType: 'semSearchToolCall',
    // 无专用 exec channel — 客户端在本地执行语义搜索后直接返回结果
    execArgsType: null,
    llmToolByProvider: {
        anthropic: ANTHROPIC,
        openai: OPENAI,
        gemini: GEMINI,
    },
    buildStartedArgs: (input) => ({
        query: str(input.query),
        ...(Array.isArray(input.target_directories) && input.target_directories.length
            ? { targetDirectories: input.target_directories.map(String) }
            : {}),
        ...(typeof input.explanation === 'string' ? { explanation: input.explanation } : {}),
    }),
};
