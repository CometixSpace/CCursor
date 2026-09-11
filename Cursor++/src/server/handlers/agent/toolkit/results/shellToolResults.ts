import { envelope, num, str, truncate, type ToolResultEnvelope } from './shared';

/**
 * Shell 输出截断阈值 — 对齐 cursor-agent-exec 的 `co` 累加器 (main.unminify.js:192898)。
 *
 * 官方策略 (ao = 1e4):
 *   合并输出 <= 10000 字符 → interleaved_output 给全文,不填截断字段
 *   合并输出 >  10000 字符 → interleaved_output 置空,改填
 *       output_head   前 5000 字符
 *       output_tail   后 5000 字符
 *       elided_chars  totalChars - 10000
 *   stdout / stderr 各自始终填充,上限 1 MB (Cn = 1048576)。
 *
 * 我们在 shell stream 路径上自行累加 stdout/stderr,因此需要复刻同一套策略,
 * 否则长输出会把 1 MB 原文喂进上下文,且朴素头部截断会丢掉尾部报错。
 */
const SHELL_OUTPUT_FULL_MAX = 10000;
const SHELL_OUTPUT_SIDE = 5000;

/** 按官方阈值计算截断三元组;未超阈值返回 undefined (此时应给全文)。 */
function buildOutputTruncation(combined: string): { outputHead: string; outputTail: string; elidedChars: number } | undefined {
    if (combined.length <= SHELL_OUTPUT_FULL_MAX) return undefined;
    return {
        outputHead: combined.slice(0, SHELL_OUTPUT_SIDE),
        outputTail: combined.slice(-SHELL_OUTPUT_SIDE),
        elidedChars: combined.length - SHELL_OUTPUT_FULL_MAX,
    };
}

export function buildShellToolResult(
    input: Record<string, unknown>,
    state: {
        stdout: string;
        stderr: string;
        exitCode: number;
        cwd?: string;
        localExecutionTimeMs?: number;
        rejected?: { reason?: string };
        permissionDenied?: { command?: string; workingDirectory?: string; error?: string };
        /**
         * 命令转后台 (ShellStreamBackgrounded)。执行侧(cursor-agent-exec)在超时/用户请求时
         * 把 shell 转后台并回报 shellId/pid/msToWait/reason; server 据此构造"已转后台"结果,
         * 而非误把片段输出 + exitCode=0 当成功。
         */
        backgrounded?: {
            shellId: number;
            pid?: number;
            msToWait?: number;
            /** ShellBackgroundReason: 0=UNSPECIFIED, 1=TIMEOUT, 2=USER_REQUEST */
            reason?: number;
            terminalsFolder?: string;
        };
    },
): ToolResultEnvelope {
    if (state.rejected) {
        return { result: { case: 'rejected', value: { reason: state.rejected.reason ?? 'rejected' } } };
    }
    if (state.backgrounded) {
        const command = str(input.command);
        const workingDirectory = str(state.cwd ?? input.workingDirectory ?? input.cwd);
        const combined = `${state.stdout}${state.stderr}`;
        // ShellSuccess 携带 shell_id(9) / pid(13) / ms_to_wait(15?) / background_reason(14)。
        // 这里按 success case 落盘,文本侧(buildShellToolResultText)依 shellId 识别后台态并复刻
        // 客户端 kZ 的 "moved to background" 措辞。
        return {
            result: {
                case: 'success',
                value: {
                    command,
                    workingDirectory,
                    output: combined,
                    stdout: state.stdout || undefined,
                    stderr: state.stderr || undefined,
                    exitCode: state.exitCode | 0,
                    localExecutionTimeMs: num(state.localExecutionTimeMs),
                    shellId: state.backgrounded.shellId,
                    ...(state.backgrounded.pid !== undefined ? { pid: state.backgrounded.pid } : {}),
                    ...(state.backgrounded.msToWait !== undefined ? { msToWait: state.backgrounded.msToWait } : {}),
                    ...(state.backgrounded.reason !== undefined ? { backgroundReason: state.backgrounded.reason } : {}),
                    ...(state.backgrounded.terminalsFolder ? { terminalsFolder: state.backgrounded.terminalsFolder } : {}),
                },
            },
        };
    }
    if (state.permissionDenied) {
        return {
            result: {
                case: 'permissionDenied',
                value: {
                    command: state.permissionDenied.command ?? str(input.command),
                    workingDirectory: state.permissionDenied.workingDirectory ?? str(input.workingDirectory ?? input.cwd),
                    error: state.permissionDenied.error ?? 'permission denied',
                },
            },
        };
    }

    const command = str(input.command);
    const workingDirectory = str(state.cwd ?? input.workingDirectory ?? input.cwd);
    const combined = `${state.stdout}${state.stderr}`;

    // 超阈值时 output(interleaved) 置空、改填 head/tail/elided,与官方 co 累加器一致。
    const truncation = buildOutputTruncation(combined);

    if (state.exitCode === 0) {
        return {
            result: {
                case: 'success',
                value: {
                    command,
                    workingDirectory,
                    output: truncation ? '' : combined,
                    stdout: state.stdout || undefined,
                    stderr: state.stderr || undefined,
                    exitCode: state.exitCode | 0,
                    localExecutionTimeMs: num(state.localExecutionTimeMs),
                    ...(truncation ?? {}),
                },
            },
        };
    }

    return {
        result: {
            case: 'failure',
            value: {
                command,
                workingDirectory,
                stdout: state.stdout,
                stderr: state.stderr,
                output: truncation ? '' : combined,
                exitCode: state.exitCode | 0,
                localExecutionTimeMs: num(state.localExecutionTimeMs),
                ...(truncation ?? {}),
            },
        },
    };
}

export function normalizeShellToolResult(
    resultCaseName: string,
    value: Record<string, unknown>,
    input: Record<string, unknown>,
): ToolResultEnvelope {
    if (resultCaseName === 'success' || resultCaseName === 'failure') {
        return envelope(resultCaseName, {
            command: str(value.command, str(input.command)),
            workingDirectory: str(value.workingDirectory, str(input.workingDirectory ?? input.cwd)),
            output: str(value.output),
            ...(typeof value.stdout === 'string' ? { stdout: value.stdout } : {}),
            ...(typeof value.stderr === 'string' ? { stderr: value.stderr } : {}),
            exitCode: num(value.exitCode) | 0,
            ...(value.localExecutionTimeMs !== undefined ? { localExecutionTimeMs: num(value.localExecutionTimeMs) } : {}),
            ...(typeof value.interleavedOutput === 'string' ? { interleavedOutput: value.interleavedOutput } : {}),
            // 输出截断三元组 (客户端 > 10000 字符时下发),文本侧据此复刻 head/tail 渲染。
            ...(typeof value.outputHead === 'string' ? { outputHead: value.outputHead } : {}),
            ...(typeof value.outputTail === 'string' ? { outputTail: value.outputTail } : {}),
            ...(value.elidedChars !== undefined ? { elidedChars: num(value.elidedChars) } : {}),
            // 后台态字段透传(命令转后台时由 buildShellToolResult 填入),供文本侧识别并复刻 kZ 提示。
            ...(value.shellId !== undefined ? { shellId: num(value.shellId) } : {}),
            ...(value.pid !== undefined ? { pid: num(value.pid) } : {}),
            ...(value.msToWait !== undefined ? { msToWait: num(value.msToWait) } : {}),
            ...(value.backgroundReason !== undefined ? { backgroundReason: num(value.backgroundReason) } : {}),
            ...(typeof value.terminalsFolder === 'string' ? { terminalsFolder: value.terminalsFolder } : {}),
        });
    }
    if (resultCaseName === 'permissionDenied' || resultCaseName === 'spawnError') {
        return envelope(resultCaseName, {
            command: str(value.command, str(input.command)),
            workingDirectory: str(value.workingDirectory, str(input.workingDirectory ?? input.cwd)),
            error: str(value.error, resultCaseName),
        });
    }
    if (resultCaseName === 'rejected') {
        return envelope('rejected', { reason: str(value.reason, 'rejected') });
    }
    return envelope(resultCaseName || 'error', value);
}

/**
 * 复刻客户端 kZ (main.unminify.js:123910) 的"已转后台"提示文本。
 *
 * 客户端原文 (3.5.38):
 *   USER_REQUEST: "The user manually backgrounded the command after {msToWait}ms."
 *   有 msToWait : "The command did not complete in {msToWait}ms and was sent to the background.\n"
 *   兜底       : "Command exceeded block_until_ms and was moved to background.\n\n"
 *   随后附 "Output before backgrounding" + "Shell ID: {id}\n" + 可选 "PID: {pid}\n"
 *   + "Output will continue to be written to {path}. Don't mention Shell ID to the user."
 *   其中 path = {terminalsFolder}/{shellId}.txt (terminalsFolder 即终端文件目录)。
 */
function buildBackgroundedText(value: Record<string, unknown>): string {
    const shellId = num(value.shellId);
    const pid = typeof value.pid === 'number' ? value.pid : undefined;
    const msToWait = typeof value.msToWait === 'number' ? value.msToWait : undefined;
    const reason = num(value.backgroundReason); // 1=TIMEOUT, 2=USER_REQUEST
    const terminalsFolder = str(value.terminalsFolder);
    const outputPath = terminalsFolder ? `${terminalsFolder}/${shellId}.txt` : `<terminals_folder>/${shellId}.txt`;
    const collectedOutput = str(value.output) || `${str(value.stdout)}${str(value.stderr)}`;

    let head: string;
    if (reason === 2) {
        head = `The user manually backgrounded the command${msToWait !== undefined ? ` after ${msToWait}ms` : ''}.\n`;
    } else if (msToWait !== undefined) {
        head = `The command did not complete in ${msToWait}ms and was sent to the background.\n`;
    } else {
        head = 'Command exceeded block_until_ms and was moved to background.\n\n';
    }

    let text = head;
    if (collectedOutput.trim().length > 0) {
        text += `Output before backgrounding:\n\n\`\`\`\n${collectedOutput}\n\`\`\`\n\n`;
    }
    text += `Shell ID: ${shellId}\n`;
    if (pid !== undefined && pid !== 0) text += `PID: ${pid}\n`;
    text += `Output will continue to be written to ${outputPath}. Don't mention Shell ID to the user. Use AwaitShell with this Shell ID to poll for completion.`;
    return text;
}

export function buildShellToolResultText(
    resultCaseName: string,
    value: Record<string, unknown>,
    input: Record<string, unknown>,
): string {
    // 后台态: success case 但携带 shellId(命令已转后台,而非真正完成)。
    if (resultCaseName === 'success' && value.shellId !== undefined) {
        return buildBackgroundedText(value);
    }
    if (resultCaseName === 'success' || resultCaseName === 'failure') {
        const head = str(value.outputHead);
        const tail = str(value.outputTail);
        const elided = num(value.elidedChars);

        // 截断态: 优先用官方 head/tail 表示。朴素的头部截断会丢掉尾部,
        // 而编译/测试类命令的报错通常正在尾部。
        if (head || tail) {
            return [
                `command: ${str(value.command, str(input.command))}`,
                `exit_code: ${num(value.exitCode)}`,
                head ? `output (first ${head.length} chars):\n${head}` : '',
                elided > 0 ? `... [${elided} chars elided] ...` : '',
                tail ? `output (last ${tail.length} chars):\n${tail}` : '',
            ].filter(Boolean).join('\n\n');
        }

        const stdout = str(value.stdout);
        const stderr = str(value.stderr);
        const output = str(value.output);
        return truncate([
            `command: ${str(value.command, str(input.command))}`,
            `exit_code: ${num(value.exitCode)}`,
            stdout ? `stdout:\n${stdout}` : '',
            stderr ? `stderr:\n${stderr}` : '',
            !stdout && !stderr && output ? `output:\n${output}` : '',
        ].filter(Boolean).join('\n\n'));
    }
    if (resultCaseName === 'permissionDenied') {
        return `Shell permission denied: ${str(value.error, 'permission denied')}`;
    }
    if (resultCaseName === 'rejected') {
        return `Shell rejected: ${str(value.reason, 'rejected')}`;
    }
    return `Shell ${resultCaseName || 'error'}: ${JSON.stringify(value)}`;
}
