/**
 * Summarization Prompt — 官方 Cursor summarize prompt（逆向提取）
 *
 * 通过 prompt injection probe 从官方 Cursor 服务端提取的完整 summarize 指令。
 * 详见 analysis/official-summarize-prompt-reverse.md
 *
 * 架构：
 * - SUMMARY_SYSTEM_PROMPT: LLM system message
 * - SUMMARY_USER_TEMPLATE: LLM user message 模板（包含 <summarization_request> 标签）
 * - buildSummaryUserMessage(): 将对话内容填入模板
 */

export const SUMMARY_SYSTEM_PROMPT = `You are an intelligent assistant, tasked with summarizing the following conversation. You MUST follow the instructions given in the <summarization_request> tags and summarize the conversation. This summary will be provided to another AI assistant to continue the task at hand, so you should align the summary with the task in the conversation.`;

const SUMMARY_USER_TEMPLATE = `<conversation_transcript>
{CONVERSATION}
</conversation_transcript>

<summarization_request>What you see above is the conversation so far, rendered as a transcript. Previous user messages, previous assistant messages, and tool calls are shown in tags, while the original system prompt has been removed. The content in the tags has been rendered exactly as it was in the original conversation.

Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions. This summary will be provided to another AI assistant to continue the task at hand, so you should align the summary with the task in the conversation above. So you should NEVER refer to summarization in your summary, just an output that could be used to continue the task.

This summary should be thorough in capturing technical details, code patterns, and architectural decisions
that would be essential for continuing development work without losing context.

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
   - file names
   - full code snippets
   - function signatures
   - file edits
- Errors that you ran into and how you fixed them
- Pay special attention to specific user feedback that you received, especially if the user told you to do
something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results or subagent prompts/results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed.

If there is a next step, include direct quotes from the most recent conversation
showing exactly what task you were working on and where you left off. This should be verbatim to ensure
there's no drift in task interpretation.

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.

IMPORTANT NOTE ON TRUNCATED TOOL OUTPUT: Some tool outputs in the transcript above may be marked with [truncated] or [omitted] — they were shortened to fit this summary request. In your summary, you MUST still preserve their file paths, shell commands, agentIds, and any conclusions or error information they contain, because later work depends on them. The original full output can be recovered by re-running the tool, so mention in the relevant sections that re-running (e.g. re-reading a file or re-running the subagent) can restore the full content.</summarization_request>`;

export function buildSummaryUserMessage(summarySourceText: string): string {
    return SUMMARY_USER_TEMPLATE.replace('{CONVERSATION}', summarySourceText);
}
