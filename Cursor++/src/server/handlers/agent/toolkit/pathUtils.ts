// Joining a child can turn a server-only prefix into a complete UNC share.
const WINDOWS_UNC_RE = /^[\\/]{2}/;

function isUncPath(value: string): boolean {
  return WINDOWS_UNC_RE.test(value);
}

/**
 * Minimal server-side path validation only.
 *
 * Official Cursor client/agent-exec performs the real path/cwd interpretation
 * relative to workspace and shell state. The BYOK server must not re-invent
 * that logic using its own process.platform / process.cwd() / homedir().
 */
export function resolveToolPath(rawPath: unknown, _workspacePath?: string): string {
  if (typeof rawPath !== 'string') return '';
  if (rawPath.includes('\0')) throw new Error('Path contains null bytes');
  return rawPath;
}

/**
 * Server-side filesystem operations must not touch UNC paths. On Windows, IO on
 * an attacker-controlled UNC host may trigger SMB/NTLM authentication. Tools
 * that need server-side content computation should fail closed.
 */
export function assertSafeForServerFs(filePath: string, operation: string): void {
  if (isUncPath(filePath)) {
    throw new Error(`${operation} refused to access UNC path on the server: ${filePath}`);
  }
}
