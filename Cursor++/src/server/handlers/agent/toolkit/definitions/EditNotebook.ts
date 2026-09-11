import { str, num, bool } from '../shared';
import type { ToolRegistryEntry } from '../types';

const ANTHROPIC = {
    name: 'EditNotebook',
    description: `Use this tool to edit a jupyter notebook cell. Use ONLY this tool to edit notebooks.

This tool supports editing existing cells and creating new cells:
	- If you need to edit an existing cell, set 'is_new_cell' to false and provide the 'old_string' and 'new_string'.
		-- The tool will replace ONE occurrence of 'old_string' with 'new_string' in the specified cell.
	- If you need to create a new cell, set 'is_new_cell' to true and provide the 'new_string' (and keep 'old_string' empty).
		-- It's critical that you set the 'is_new_cell' flag correctly!
	- This tool does NOT support cell deletion, but you can delete the content of a cell by passing an empty string as the 'new_string'.

Other requirements:
	- Cell indices are 0-based.
	- 'old_string' and 'new_string' should be a valid cell content, i.e. WITHOUT any JSON syntax that notebook files use under the hood.
	- The old_string MUST uniquely identify the specific instance you want to change. This means:
		-- Include AT LEAST 3-5 lines of context BEFORE the change point
		-- Include AT LEAST 3-5 lines of context AFTER the change point
	- This tool can only change ONE instance at a time. If you need to change multiple instances:
		-- Make separate calls to this tool for each instance
		-- Each call must uniquely identify its specific instance using extensive context
	- This tool might save markdown cells as "raw" cells. Don't try to change it, it's fine. We need it to properly display the diff.
	- If you need to create a new notebook, just set 'is_new_cell' to true and cell_idx to 0.
	- ALWAYS generate arguments in the following order: target_notebook, cell_idx, is_new_cell, cell_language, old_string, new_string.
	- Prefer editing existing cells over creating new ones!
	- ALWAYS provide ALL required arguments (including BOTH old_string and new_string). NEVER call this tool without providing 'new_string'.`,
    inputSchema: {
            "type": "object",
            "required": [
                    "target_notebook",
                    "cell_idx",
                    "is_new_cell",
                    "cell_language",
                    "old_string",
                    "new_string"
            ],
            "properties": {
                    "target_notebook": {
                            "type": "string",
                            "description": "The path to the notebook file you want to edit. You can use either a relative path in the workspace or an absolute path. If an absolute path is provided, it will be preserved as is."
                    },
                    "cell_idx": {
                            "type": "number",
                            "description": "The index of the cell to edit (0-based)"
                    },
                    "is_new_cell": {
                            "type": "boolean",
                            "description": "If true, a new cell will be created at the specified cell index. If false, the cell at the specified cell index will be edited."
                    },
                    "cell_language": {
                            "type": "string",
                            "description": "The language of the cell to edit. Should be STRICTLY one of these: 'python', 'markdown', 'javascript', 'typescript', 'r', 'sql', 'shell', 'raw' or 'other'."
                    },
                    "old_string": {
                            "type": "string",
                            "description": "The text to replace (must be unique within the cell, and must match the cell contents exactly, including all whitespace and indentation)."
                    },
                    "new_string": {
                            "type": "string",
                            "description": "The edited text to replace the old_string or the content for the new cell."
                    }
            }
    },
};

const OPENAI = {
    name: 'EditNotebook',
    description: `Use this tool to edit a jupyter notebook cell. Use ONLY this tool to edit notebooks.

This tool supports editing existing cells and creating new cells:
- If you need to edit an existing cell, set 'is_new_cell' to false and provide the 'old_string' and 'new_string'.
-- The tool will replace ONE occurrence of 'old_string' with 'new_string' in the specified cell.
- If you need to create a new cell, set 'is_new_cell' to true and provide the 'new_string' (and keep 'old_string' empty).
- It's critical that you set the 'is_new_cell' flag correctly!
- This tool does NOT support cell deletion, but you can delete the content of a cell by passing an empty string as the 'new_string'.

Other requirements:
- Cell indices are 0-based.
- 'old_string' and 'new_string' should be a valid cell content, i.e. WITHOUT any JSON syntax that notebook files use under the hood.
- The old_string MUST uniquely identify the specific instance you want to change. This means:
-- Include AT LEAST 3-5 lines of context BEFORE the change point
-- Include AT LEAST 3-5 lines of context AFTER the change point
- This tool can only change ONE instance at a time. If you need to change multiple instances:
-- Make separate calls to this tool for each instance
-- Each call must uniquely identify its specific instance using extensive context
- This tool might save markdown cells as "raw" cells. Don't try to change it, it's fine. We need it to properly display the diff.
- If you need to create a new notebook, just set 'is_new_cell' to true and cell_idx to 0.
- ALWAYS generate arguments in the following order: target_notebook, cell_idx, is_new_cell, cell_language, old_string, new_string.
- Prefer editing existing cells over creating new ones!
- ALWAYS provide ALL required arguments (including BOTH old_string and new_string). NEVER call this tool without providing 'new_string'.`,
    inputSchema: {
            "type": "object",
            "properties": {
                    "target_notebook": {
                            "type": "string",
                            "description": "The path to the notebook file you want to edit. You can use either a relative path in the workspace or an absolute path. If an absolute path is provided, it will be preserved as is."
                    },
                    "cell_idx": {
                            "type": "number",
                            "description": "The index of the cell to edit (0-based)"
                    },
                    "is_new_cell": {
                            "type": "boolean",
                            "description": "If true, a new cell will be created at the specified cell index. If false, the cell at the specified cell index will be edited."
                    },
                    "cell_language": {
                            "type": "string",
                            "description": "The language of the cell to edit. Should be STRICTLY one of these: 'python', 'markdown', 'javascript', 'typescript', 'r', 'sql', 'shell', 'raw' or 'other'.",
                            "enum": [
                                    "python",
                                    "markdown",
                                    "javascript",
                                    "typescript",
                                    "r",
                                    "sql",
                                    "shell",
                                    "raw",
                                    "other"
                            ]
                    },
                    "old_string": {
                            "type": "string",
                            "description": "The text to replace (must be unique within the cell, and must match the cell contents exactly, including all whitespace and indentation)."
                    },
                    "new_string": {
                            "type": "string",
                            "description": "The edited text to replace the old_string or the content for the new cell."
                    }
            },
            "required": [
                    "target_notebook",
                    "cell_idx",
                    "is_new_cell",
                    "cell_language",
                    "old_string",
                    "new_string"
            ]
    },
};

/**
 * 读取 ipynb 文件，修改指定 cell，返回完整的新文件内容。
 *
 * ipynb 格式: { cells: [{ cell_type, source: string[], ... }, ...], ... }
 * source 是行数组（每行末尾含 \n，最后一行可能不含）。
 */
export function applyNotebookEditToContent(
    rawContent: string,
    cellIdx: number,
    isNewCell: boolean,
    cellLanguage: string,
    oldString: string,
    newString: string,
): string {
    const nb = JSON.parse(rawContent);

    if (!Array.isArray(nb.cells)) {
        throw new Error('Invalid notebook: missing cells array');
    }

    if (isNewCell) {
        // 创建新 cell 并插入到指定位置
        const cellType = cellLanguage === 'markdown' ? 'markdown' : 'code';
        const newCell: Record<string, unknown> = {
            cell_type: cellType,
            metadata: {},
            source: newString.split('\n').map((line, i, arr) =>
                i < arr.length - 1 ? `${line}\n` : line,
            ),
            ...(cellType === 'code'
                ? { execution_count: null, outputs: [] }
                : {}),
        };
        nb.cells.splice(cellIdx, 0, newCell);
    } else {
        // 编辑现有 cell
        if (cellIdx < 0 || cellIdx >= nb.cells.length) {
            throw new Error(`Cell index ${cellIdx} out of range (0..${nb.cells.length - 1})`);
        }
        const cell = nb.cells[cellIdx];
        // source 可能是 string[] 或 string
        const currentSource = Array.isArray(cell.source)
            ? cell.source.join('')
            : String(cell.source ?? '');

        if (!currentSource.includes(oldString)) {
            throw new Error(`old_string not found in cell ${cellIdx}`);
        }

        const newSource = currentSource.replace(oldString, newString);
        cell.source = newSource.split('\n').map((line: string, i: number, arr: string[]) =>
            i < arr.length - 1 ? `${line}\n` : line,
        );
    }

    // 序列化时保持 ipynb 标准缩进（1 space）并以换行结尾
    return `${JSON.stringify(nb, null, 1)}\n`;
}

export const EditNotebookTool: ToolRegistryEntry = {
    canonicalName: 'EditNotebook',
    aliases: ['EditNotebook'],
    cursorToolType: 'editToolCall',
    execArgsType: 'writeArgs',
    llmToolByProvider: {
        anthropic: ANTHROPIC,
        openai: OPENAI,
    },
    buildStartedArgs: (input) => {
        const path = str(input.target_notebook);
        return { path, streamContent: str(input.new_string) };
    },
    buildExecArgs: (input, callId) => {
        const path = str(input.target_notebook);
        return {
            path,
            streamContent: str(input.new_string),
            toolCallId: callId,
            returnFileContentAfterWrite: true,
            fileBytes: new Uint8Array(),
        };
    },
    buildEditPlan: (input) => {
        const path = str(input.target_notebook);
        return {
            kind: 'editNotebook',
            path,
            cellIdx: num(input.cell_idx),
            isNewCell: bool(input.is_new_cell),
            cellLanguage: str(input.cell_language),
            oldString: str(input.old_string),
            newString: str(input.new_string),
            streamContent: str(input.new_string),
        };
    },
};
