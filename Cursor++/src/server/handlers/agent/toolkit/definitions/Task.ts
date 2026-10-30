import { str } from '../shared';
import type { ToolRegistryEntry } from '../types';

function buildTaskSubagentType(name: string): Record<string, unknown> | undefined {
    switch (name) {
        case 'explore': return { type: { case: 'explore', value: {} } };
        case 'browser-use':
        case 'browserUse': return { type: { case: 'browserUse', value: {} } };
        case 'shell': return { type: { case: 'shell', value: {} } };
        case 'debug': return { type: { case: 'debug', value: {} } };
        case 'computer-use':
        case 'computerUse': return { type: { case: 'computerUse', value: {} } };
        case 'media-review':
        case 'mediaReview': return { type: { case: 'mediaReview', value: {} } };
        case 'watchVideo': return { type: { case: 'watchVideo', value: {} } };
        case 'cursorGuide': return { type: { case: 'cursorGuide', value: {} } };
        case 'bash': return { type: { case: 'bash', value: {} } };
        case 'vm-setup-helper':
        case 'vmSetupHelper': return { type: { case: 'vmSetupHelper', value: {} } };
        case 'generalPurpose':
        case 'general-purpose':
            return { type: { case: 'custom', value: { name: 'generalPurpose' } } };
        case 'ui-designer':
            return { type: { case: 'custom', value: { name: 'ui-designer' } } };
        case 'best-of-n-runner':
            return { type: { case: 'custom', value: { name: 'best-of-n-runner' } } };
        case 'bugbot':
            return { type: { case: 'custom', value: { name: 'bugbot' } } };
        case 'coordinator-agent':
            return { type: { case: 'custom', value: { name: 'coordinator-agent' } } };
        case 'worker-agent':
            return { type: { case: 'custom', value: { name: 'worker-agent' } } };
        case 'cursorBlameLearning':
            return { type: { case: 'custom', value: { name: 'cursorBlameLearning' } } };
        case 'security-review':
            return { type: { case: 'custom', value: { name: 'security-review' } } };
        default:
            return name ? { type: { case: 'custom', value: { name } } } : undefined;
    }
}

const ANTHROPIC = {
    name: 'Task',
    description: `Launch a new agent to handle complex, multi-step tasks autonomously.

The Task tool launches specialized subagents (subprocesses) that autonomously handle complex tasks. Each subagent_type has specific capabilities and tools available to it.

When using the Task tool, you must specify a subagent_type parameter to select which agent type to use.

VERY IMPORTANT: When broadly exploring the codebase to gather context for a large task, it is recommended that you use the Task tool with subagent_type="explore" instead of running search commands directly.

If the query is a narrow or specific question, you should NOT use the Task and instead address the query directly using the other tools available to you.

Examples:
- user: "Where is the ClientError class defined?" assistant: [Uses Grep directly - this is a needle query for a specific class]
- user: "Run this query using my database API" assistant: [Calls the MCP directly - this is not a broad exploration task]
- user: "What is the codebase structure?" assistant: [Uses the Task tool with subagent_type="explore"]

If it is possible to explore different areas of the codebase in parallel, you should launch multiple agents concurrently.

When NOT to use the Task tool:
- Simple, single or few-step tasks that can be performed by a single agent (using parallel or sequential tool calls) -- just call the tools directly instead.
- For example:
  - If you want to read a specific file path, use the Read or Glob tool instead of the Task tool, to find the match more quickly
  - If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead of the Task tool, to find the match more quickly
  - If you are searching for a specific class definition like "class Foo", use the Glob tool instead, to find the match more quickly

Usage notes:
- Always include a short description (3-5 words) summarizing what the agent will do
- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses.
- When the agent is done, it will return a single message back to you. Specify exactly what information the agent should return back in its final response to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.
- Agents can be resumed using the \`resume\` parameter by passing the agent ID from a previous invocation. This sends a follow-up message when the agent's turn is complete, preserving existing context. When NOT resuming, each invocation starts fresh and you should provide a highly detailed task description with all necessary context for the agent to perform its task autonomously.
- When using the Task tool, the subagent invocation does not have access to the user's message or prior assistant steps. Therefore, you should provide a highly detailed task description with all necessary context for the agent to perform its task autonomously.
- The subagent's outputs should generally be trusted
- Clearly tell the subagent which tasks you want it to perform, since it is not aware of the user's intent or your prior assistant steps (tool calls, thinking, or messages).
- If the subagent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
- If the user specifies that they want you to run subagents "in parallel", you MUST send a single message with multiple Task tool use content blocks. For example, if you need to launch both a code-reviewer subagent and a test-runner subagent in parallel, send a single message with both tool calls.
- Avoid delegating the full query to the Task tool and returning the result. In these cases, you should address the query using the other tools available to you.

Available subagent_types and a quick description of what they do:
- generalPurpose: General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. Use when searching for a keyword or file and not confident you'll find the match quickly.
- explore: Fast, readonly agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). This agent operates in read-only mode and cannot modify files. When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.
- shell: Command execution specialist for running bash commands. Use this for git operations, command execution, and other terminal tasks.
- best-of-n-runner: Run a task in an isolated git worktree. Each best-of-n-runner gets its own branch and working directory. Use for best-of-N parallel attempts or isolated experiments.
- security-review: Security audit specialist. Performs security-focused code review covering common vulnerability patterns, authentication/authorization issues, and data handling concerns.
- cursorBlameLearning: Code history analyst. Produces story-style learning reports about how code was built — who changed it, why, what tradeoffs were discussed. Use when the user asks about history, evolution, authorship, or rationale.

The model field, when present, must be a canonical ProviderModel.id advertised in this Task schema.`,
    inputSchema: {
            "type": "object",
            "required": [
                    "description",
                    "prompt"
            ],
            "properties": {
                    "description": {
                            "type": "string",
                            "description": "A short (3-5 word) description of the task"
                    },
                    "prompt": {
                            "type": "string",
                            "description": "The task for the agent to perform"
                    },
                    "subagent_type": {
                            "type": "string",
                            "enum": [
                                    "generalPurpose",
                                    "explore",
                                    "shell",
                                    "best-of-n-runner",
                                    "security-review",
                                    "cursorBlameLearning"
                            ],
                            "description": "Subagent type to use for this task."
                    },
                    "model": {
                            "type": "string",
                            "description": "Optional canonical ProviderModel.id for this Subagent. The per-run schema supplies the available IDs."
                    },
                    "readonly": {
                            "type": "boolean",
                            "description": "If true, the subagent will run in readonly mode (\"Ask mode\") with restricted write operations and no MCP access."
                    },
                    "run_in_background": {
                            "type": "boolean",
                            "description": "Run the agent in the background (returns output_file path to check later). If this is false, you will be blocked until the agent completes."
                    },
                    "resume": {
                            "type": "string",
                            "description": "Optional agent ID to resume from. If provided, sends a follow-up message to the agent when its turn is complete. Use \"self\" to start a new agent with your own entire conversation history as a starting point (aka 'self-fork')."
                    }
            }
    },
};

const OPENAI = {
    name: 'Subagent',
    description: `Launch a new agent to handle complex, multi-step tasks autonomously.

The Subagent tool launches specialized subagents (subprocesses) that autonomously handle complex tasks. Each subagent_type has specific capabilities and tools available to it.

VERY IMPORTANT: When broadly exploring the codebase to gather context for a large task, it is recommended that you use the Subagent tool with subagent_type="explore" instead of running search commands directly.

If the query is a narrow or specific question, you should NOT use the Subagent and instead address the query directly using the other tools available.

Examples:
- user: "Where is the ClientError class defined?" assistant: [Uses Grep directly - this is a needle query for a specific class]
- user: "Run this query using my database API" assistant: [Calls the MCP directly - this is not a broad exploration task]
- user: "What is the codebase structure?" assistant: [Uses the Subagent tool with subagent_type="explore"]

If it is possible to explore different areas of the codebase in parallel, you should launch multiple agents concurrently.

When NOT to use the Subagent tool:
- Simple, single or few-step tasks that can be performed by a single agent (using parallel or sequential tool calls) -- just call the tools directly instead.
- For example:
- If you want to read a specific file path, use the ReadFile or Glob tool instead of the Subagent tool, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the ReadFile tool instead of the Subagent tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use the Glob tool instead, to find the match more quickly

Usage notes:
- Always include a short description (3-5 words) summarizing the task
- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses.
- When the agent is done, it will return a single message back to you. Specify exactly what information the agent should return back in its final response to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.
- Agents can be resumed using the \`resume\` parameter by passing the agent ID from a previous invocation. This sends a follow-up message when the agent's turn is complete, preserving existing context. When NOT resuming, each invocation starts fresh and you should provide a detailed task description with all necessary context.
- When using the Subagent tool, the subagent invocation does not have access to the user's message or prior assistant steps. Therefore, you should provide a highly detailed task description with all necessary context for the agent to perform its task autonomously.
- The subagent's outputs should generally be trusted
- Clearly tell the subagent which tasks you want it to perform, since it is not aware of the user's intent or your prior assistant steps (tool calls, thinking, or messages).
- If the subagent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
- If the user specifies that they want you to run subagents "in parallel", you MUST send a single message with both tool calls. For example, if you need to launch both a code-reviewer subagent and a test-runner subagent in parallel, send a single message with both tool calls.
- Avoid delegating the full query to the Subagent tool and returning the result. In these cases, you should address the query using the other tools available.

Available subagent_types and a quick description of what they do:
- generalPurpose: General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. Use when searching for a keyword or file and not confident you'll find the match quickly.
- explore: Fast, readonly agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). This agent operates in read-only mode and cannot modify files. When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.
- shell: Command execution specialist for running bash commands. Use this for git operations, command execution, and other terminal tasks.
- best-of-n-runner: Run a task in an isolated git worktree. Each best-of-n-runner gets its own branch and working directory. Use for best-of-N parallel attempts or isolated experiments.
- security-review: Security audit specialist. Performs security-focused code review covering common vulnerability patterns, authentication/authorization issues, and data handling concerns.
- cursorBlameLearning: Code history analyst. Produces story-style learning reports about how code was built — who changed it, why, what tradeoffs were discussed. Use when the user asks about history, evolution, authorship, or rationale.

The model field, when present, must be a canonical ProviderModel.id advertised in this Subagent schema.`,
    inputSchema: {
            "type": "object",
            "properties": {
                    "description": {
                            "type": "string",
                            "description": "A short (3-5 words) description of the task"
                    },
                    "prompt": {
                            "type": "string",
                            "description": "The task for the agent to perform"
                    },
                    "model": {
                            "type": "string",
                            "description": "Optional canonical ProviderModel.id for this Subagent. The per-run schema supplies the available IDs."
                    },
                    "resume": {
                            "type": "string",
                            "description": "Optional agent ID to resume from. If provided, sends a follow-up message to the agent when its turn is complete. Use \"self\" to start a new agent with your own entire conversation history as a starting point (aka 'self-fork')."
                    },
                    "readonly": {
                            "type": "boolean",
                            "description": "If true, the subagent will run in readonly mode (\"Ask mode\") with restricted write operations and no MCP access."
                    },
                    "subagent_type": {
                            "type": "string",
                            "description": "Subagent type to use for this task. Must be one of: generalPurpose, explore, shell, best-of-n-runner.",
                            "enum": [
                                    "generalPurpose",
                                    "explore",
                                    "shell",
                                    "best-of-n-runner"
                            ]
                    },
                    "run_in_background": {
                            "type": "boolean",
                            "description": "Run the agent in the background (returns output_file path to check later). If this is false, you will be blocked until the agent completes."
                    }
            },
            "required": [
                    "description",
                    "prompt"
            ]
    },
};

const GEMINI = {
    name: 'Task',
    description: `Launch a new agent to handle complex, multi-step tasks autonomously.

The Task tool launches specialized subagents (subprocesses) that autonomously handle complex tasks. Each subagent_type has specific capabilities and tools available to it.

When using the Task tool, you must specify a subagent_type parameter to select which agent type to use.

VERY IMPORTANT: When broadly exploring the codebase to gather context for a large task, it is recommended that you use the Task tool with subagent_type="explore" instead of running search commands directly.

If the query is a narrow or specific question, you should NOT use the Task and instead address the query directly using the other tools available to you.

Examples:
- user: "Where is the ClientError class defined?" assistant: [Uses Grep directly - this is a needle query for a specific class]
- user: "Run this query using my database API" assistant: [Calls the MCP directly - this is not a broad exploration task]
- user: "What is the codebase structure?" assistant: [Uses the Task tool with subagent_type="explore"]

If it is possible to explore different areas of the codebase in parallel, you should launch multiple agents concurrently.

When NOT to use the Task tool:
- Simple, single or few-step tasks that can be performed by a single agent (using parallel or sequential tool calls) -- just call the tools directly instead.
- For example:
  - If you want to read a specific file path, use the Read or Glob tool instead of the Task tool, to find the match more quickly
  - If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead of the Task tool, to find the match more quickly
  - If you are searching for a specific class definition like "class Foo", use the Glob tool instead, to find the match more quickly

Usage notes:
- Always include a short description (3-5 words) summarizing what the agent will do
- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses.
- When the agent is done, it will return a single message back to you. Specify exactly what information the agent should return back in its final response to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.
- Agents can be resumed using the \`resume\` parameter by passing the agent ID from a previous invocation. This sends a follow-up message when the agent's turn is complete, preserving existing context. When NOT resuming, each invocation starts fresh and you should provide a detailed task description with all necessary context.
- When using the Task tool, the subagent invocation does not have access to the user's message or prior assistant steps. Therefore, you should provide a highly detailed task description with all necessary context for the agent to perform its task autonomously.
- The subagent's outputs should generally be trusted
- Clearly tell the subagent which tasks you want it to perform, since it is not aware of the user's intent or your prior assistant steps (tool calls, thinking, or messages).
- If the subagent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
- If the user specifies that they want you to run subagents "in parallel", you MUST send a single message with multiple Task tool use content blocks. For example, if you need to launch both a code-reviewer subagent and a test-runner subagent in parallel, send a single message with both tool calls.
- Avoid delegating the full query to the Task tool and returning the result. In these cases, you should address the query using the other tools available to you.

Available subagent_types and a quick description of what they do:
- generalPurpose: General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. Use when searching for a keyword or file and not confident you'll find the match quickly.
- explore: Fast, readonly agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). This agent operates in read-only mode and cannot modify files. When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.
- shell: Command execution specialist for running bash commands. Use this for git operations, command execution, and other terminal tasks.
- best-of-n-runner: Run a task in an isolated git worktree. Each best-of-n-runner gets its own branch and working directory. Use for best-of-N parallel attempts or isolated experiments.
- security-review: Security audit specialist. Performs security-focused code review covering common vulnerability patterns, authentication/authorization issues, and data handling concerns.
- cursorBlameLearning: Code history analyst. Produces story-style learning reports about how code was built — who changed it, why, what tradeoffs were discussed. Use when the user asks about history, evolution, authorship, or rationale.

The model field, when present, must be a canonical ProviderModel.id advertised in this Task schema.`,
    inputSchema: {
            "type": "OBJECT",
            "properties": {
                    "description": {
                            "type": "STRING",
                            "description": "A short (3-5 word) description of the task"
                    },
                    "model": {
                            "type": "STRING",
                            "description": "Optional canonical ProviderModel.id for this Subagent. The per-run schema supplies the available IDs."
                    },
                    "prompt": {
                            "type": "STRING",
                            "description": "The task for the agent to perform"
                    },
                    "readonly": {
                            "type": "BOOLEAN",
                            "description": "If true, the subagent will run in readonly mode (\"Ask mode\") with restricted write operations and no MCP access."
                    },
                    "resume": {
                            "type": "STRING",
                            "description": "Optional agent ID to resume from. If provided, sends a follow-up message to the agent when its turn is complete. Use \"self\" to start a new agent with your own entire conversation history as a starting point (aka 'self-fork')."
                    },
                    "run_in_background": {
                            "type": "BOOLEAN",
                            "description": "Run the agent in the background (returns output_file path to check later). If this is false, you will be blocked until the agent completes."
                    },
                    "subagent_type": {
                            "type": "STRING",
                            "enum": [
                                    "generalPurpose",
                                    "explore",
                                    "shell",
                                    "best-of-n-runner",
                                    "security-review",
                                    "cursorBlameLearning"
                            ],
                            "description": "Subagent type to use for this task."
                    }
            },
            "required": [
                    "description",
                    "prompt"
            ]
    },
};

export const TaskTool: ToolRegistryEntry = {
    canonicalName: 'Task',
    aliases: ["Task","Subagent"],
    cursorToolType: 'taskToolCall',
    execArgsType: 'subagentArgs',
    llmToolByProvider: {
        anthropic: ANTHROPIC,
        openai: OPENAI,
        gemini: GEMINI,
    },
    buildStartedArgs: (input) => {
        const subagentTypeName = str(input.subagent_type ?? input.subagentType, 'explore');
        const subagentType = buildTaskSubagentType(subagentTypeName);
        return {
            description: str(input.description),
            prompt: str(input.prompt),
            ...(subagentType ? { subagentType } : {}),
            ...(typeof input.resume === 'string' ? { resume: input.resume } : {}),
            ...(typeof input.agentId === 'string' ? { agentId: input.agentId } : {}),
        };
    },
    buildExecArgs: (input, callId, options = {}) => {
        const subagentType = typeof input.subagent_type === 'string'
            ? input.subagent_type
            : typeof input.subagentType === 'string'
                ? input.subagentType
                : 'explore';
        const modelId = options.currentModelId || '';
        // resume="self" 是官方 Task schema 的 self-fork 语义(见 resume 参数描述):
        // 把当前父对话 fork 成新子 agent。客户端 createOrResumeSubagent 收到 forkAgentId 后
        // deepCloneComposer 复制当前对话历史 —— 而非 resume 一个名为 "self" 的 agent
        // (若误当 resumeAgentId="self",客户端 getComposerHandleById("self") 找不到会报错)。
        const isSelfFork = typeof input.resume === 'string' && input.resume.trim().toLowerCase() === 'self'
        return {
            toolCallId: callId,
            subagentType,
            modelId,
            prompt: input.prompt || input.description || '',
            // proto3 bool 默认 false — LLM 不传 readonly 时 subagent 可读写(Agent 模式)
            readonly: input.readonly ?? false,
            // self-fork → forkAgentId=当前 conversationId;普通 resume → resumeAgentId
            ...(isSelfFork
                ? (options.conversationId ? { forkAgentId: options.conversationId } : {})
                : typeof input.resume === 'string' ? { resumeAgentId: input.resume } : {}),
            ...(typeof input.run_in_background === 'boolean' || typeof input.runInBackground === 'boolean'
                ? { runInBackground: input.run_in_background ?? input.runInBackground } : {}),
            ...(options.conversationId ? { parentConversationId: options.conversationId } : {}),
        };
    },
};
