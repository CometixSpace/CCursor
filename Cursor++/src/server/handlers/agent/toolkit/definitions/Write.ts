import { str } from '../shared';
import type { ToolRegistryEntry } from '../types';

const ANTHROPIC = {
    name: 'Write',
    description: `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.`,
    inputSchema: {
            "type": "object",
            "required": [
                    "path",
                    "contents"
            ],
            "properties": {
                    "path": {
                            "type": "string",
                            "description": "The absolute path to the file to modify"
                    },
                    "contents": {
                            "type": "string",
                            "description": "The contents to write to the file"
                    }
            }
    },
};

const GEMINI = {
    name: 'Write',
    description: `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.`,
    inputSchema: {
            "type": "OBJECT",
            "properties": {
                    "contents": {
                            "type": "STRING",
                            "description": "The contents to write to the file"
                    },
                    "path": {
                            "type": "STRING",
                            "description": "The absolute path to the file to modify"
                    }
            },
            "required": [
                    "path",
                    "contents"
            ]
    },
};

function normalizeTextForCursorWrite(text: string): string {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export const WriteTool: ToolRegistryEntry = {
    canonicalName: 'Write',
    aliases: ["Write"],
    cursorToolType: 'editToolCall',
    execArgsType: 'writeArgs',
    llmToolByProvider: {
        anthropic: ANTHROPIC,
        // OpenAI 使用 ApplyPatch 而非 Write — 见 ApplyPatch.ts
        gemini: GEMINI,
    },
    buildStartedArgs: (input) => ({
        path: str(input.path),
    }),
    buildExecArgs: (input, callId) => {
        const path = str(input.path);
        const fileText = normalizeTextForCursorWrite(typeof input.contents === 'string' ? input.contents : '');
        return {
            path,
            fileText,
            streamContent: fileText,
            encodingHint: 'utf8',
            toolCallId: callId,
        };
    },
    buildEditPlan: (input) => {
        const path = str(input.path);
        const contents = normalizeTextForCursorWrite(typeof input.contents === 'string' ? input.contents : '');
        return {
            kind: 'write',
            path,
            contents,
            streamContent: contents,
        };
    },
};
