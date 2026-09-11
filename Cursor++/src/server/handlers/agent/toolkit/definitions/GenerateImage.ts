import { str } from '../shared';
import type { ToolRegistryEntry } from '../types';

const ANTHROPIC = {
    name: 'GenerateImage',
    description: `Generate an image file from a text description.

STRICT INVOCATION RULES (must follow):
- Only use this tool when the user explicitly asks for an image. Do not generate images "just to be helpful".
- Do not use this tool for data heavy visualizations such as charts, plots, tables.

General guidelines:
- Provide a concrete description first: subject(s), layout, style, colors, text (if any), and constraints.
- If the user provides reference images, include them in \`reference_image_paths\`.
- Do not embed Markdown images in your response, the client will display the images automatically.

Examples that should call this tool:
- user: "Generate an app icon for a note-taking app, minimal flat vector style." (explicitly requests an image asset)
- user: "Make a UI mockup of a settings screen with a dark mode toggle." (explicitly requests a UI mockup)
- user: "Generate an asset of a game character with a sword." (explicitly requests a visual asset)

Examples that should not call this tool:
- user: "Create a plan to refactor this module." (planning request; respond in text or mermaid diagram)
- user: "Generate a chart of sales and revenue using data.csv." (data visualization; generate via code)`,
    inputSchema: {
            "type": "object",
            "required": [
                    "description"
            ],
            "properties": {
                    "description": {
                            "type": "string",
                            "description": "A detailed description of the image."
                    },
                    "filename": {
                            "type": "string",
                            "description": "Optional filename for the generated image (e.g., 'diagram.png'). Do not include a directory path - the tool automatically handles where to save and how to display the image. If not provided, a timestamped filename will be generated."
                    },
                    "reference_image_paths": {
                            "type": "array",
                            "description": "Optional array of file paths to reference images as additional inputs.",
                            "items": {
                                    "type": "string"
                            }
                    }
            }
    },
};

const OPENAI = {
    name: 'GenerateImage',
    description: `Generate an image file from a text description.

STRICT INVOCATION RULES (must follow):
- Only use this tool when the user explicitly asks for an image. Do not generate images "just to be helpful".
- Do not use this tool for data heavy visualizations such as charts, plots, tables.

General guidelines:
- Provide a concrete description first: subject(s), layout, style, colors, text (if any), and constraints.
- If the user provides reference images, include them in \`reference_image_paths\`.
- Do not embed Markdown images in your response, the client will display the images automatically.

Examples that should call this tool:
- user: "Generate an app icon for a note-taking app, minimal flat vector style." (explicitly requests an image asset)
- user: "Make a UI mockup of a settings screen with a dark mode toggle." (explicitly requests a UI mockup)
- user: "Generate an asset of a game character with a sword." (explicitly requests a visual asset)

Examples that should not call this tool:
- user: "Create a plan to refactor this module." (planning request; respond in text or mermaid diagram)
- user: "Generate a chart of sales and revenue using data.csv." (data visualization; generate via code)`,
    inputSchema: {
            "type": "object",
            "properties": {
                    "description": {
                            "type": "string",
                            "description": "A detailed description of the image."
                    },
                    "filename": {
                            "type": "string",
                            "description": "Optional filename for the generated image (e.g., 'diagram.png'). Do not include a directory path - the tool automatically handles where to save and how to display the image."
                    },
                    "reference_image_paths": {
                            "type": "array",
                            "description": "Optional array of file paths to reference images as additional inputs.",
                            "items": {
                                    "type": "string"
                            }
                    }
            },
            "required": [
                    "description"
            ]
    },
};

const GEMINI = {
    name: 'GenerateImage',
    description: `Generate an image file from a text description.

STRICT INVOCATION RULES (must follow):
- Only use this tool when the user explicitly asks for an image. Do not generate images "just to be helpful".
- Do not use this tool for data heavy visualizations such as charts, plots, tables.

General guidelines:
- Provide a concrete description first: subject(s), layout, style, colors, text (if any), and constraints.
- If the user provides reference images, include them in \`reference_image_paths\`.
- Do not embed Markdown images in your response, the client will display the images automatically.

Examples that should call this tool:
- user: "Generate an app icon for a note-taking app, minimal flat vector style." (explicitly requests an image asset)
- user: "Make a UI mockup of a settings screen with a dark mode toggle." (explicitly requests a UI mockup)
- user: "Generate an asset of a game character with a sword." (explicitly requests a visual asset)

Examples that should not call this tool:
- user: "Create a plan to refactor this module." (planning request; respond in text or mermaid diagram)
- user: "Generate a chart of sales and revenue using data.csv." (data visualization; generate via code)
`,
    inputSchema: {
            "type": "OBJECT",
            "properties": {
                    "description": {
                            "type": "STRING",
                            "description": "A detailed description of the image."
                    },
                    "filename": {
                            "type": "STRING",
                            "description": "Optional filename for the generated image (e.g., 'diagram.png'). Do not include a directory path - the tool automatically handles where to save and how to display the image. If not provided, a timestamped filename will be generated."
                    },
                    "reference_image_paths": {
                            "type": "ARRAY",
                            "description": "Optional array of file paths to reference images as additional inputs.",
                            "items": {
                                    "type": "STRING"
                            }
                    }
            },
            "required": [
                    "description"
            ]
    },
};

export const GenerateImageTool: ToolRegistryEntry = {
    canonicalName: 'GenerateImage',
    aliases: ['GenerateImage'],
    cursorToolType: 'generateImageToolCall',
    // 官方: 通过 writeArgs exec 写入生成的图片文件
    execArgsType: 'writeArgs',
    llmToolByProvider: {
        anthropic: ANTHROPIC,
        openai: OPENAI,
        gemini: GEMINI,
    },
    buildStartedArgs: (input) => ({
        description: str(input.description),
        ...(typeof input.filename === 'string' ? { filePath: input.filename } : {}),
        ...(Array.isArray(input.reference_image_paths) ? { referenceImagePaths: input.reference_image_paths } : {}),
    }),
    buildExecArgs: (input, callId) => ({
        path: typeof input.filename === 'string' ? input.filename : '',
        fileText: '',
        toolCallId: callId,
    }),
};
