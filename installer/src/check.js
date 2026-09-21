/**
 * ccursor check — dry-run verify all AST patch targets are matchable
 */
import { existsSync, readFileSync } from 'fs';
import { findCursorPathsDetailed, formatDiagnostic } from './detect.js';
import { checkAlwaysLocalPatch } from './patch-always-local.js';
import { checkAgentHostPatch } from './patch-agent-host.js';
import { checkProxy39Patch, needsProxy39Patch } from './patch-proxy-39.js';
import { isInjectPatched } from './patch-inject.js';

const ok = s => `\x1b[32m✓ ${s}\x1b[0m`;
const fail = s => `\x1b[31m✗ ${s}\x1b[0m`;
const info = s => `\x1b[34m[>]\x1b[0m ${s}`;

export async function check() {
  const { paths, diagnostic } = findCursorPathsDetailed();
  if (!paths) {
    console.log(fail('Cursor installation not found'));
    console.log();
    console.log(formatDiagnostic(diagnostic));
    return;
  }

  console.log(info(`Cursor: ${paths.appRoot}`));
  console.log();

  let allOk = true;

  // 1. Renderer hook anchor (inject patch) — desktop + glass
  for (const [file, label] of [[paths.workbenchJs, 'desktop'], [paths.glassJs, 'glass']]) {
    if (!existsSync(file)) {
      if (label === 'glass') console.log(info('Glass workbench not found (pre-3.8, OK)'));
      continue;
    }
    const wb = readFileSync(file, 'utf-8');
    // 与 patch-inject.js 的 ANCHORS 保持一致 —— 兼容不同版本及打包环境下
    // 包含/不包含 .js 后缀或带路径前缀的 ConnectRPC 客户端模块键。
    if (isInjectPatched(wb)) {
      console.log(ok(`Renderer hook (${label}): payload + active transport call site`));
      continue;
    }
    if (wb.includes('__byokWrapTransport') || wb.includes('CURSOR-BYOK-HOOK-START')) {
      console.log(fail(`Renderer hook (${label}) is partial (payload/call-site mismatch)`));
      allOk = false;
      continue;
    }
    const anchors = [
      'callback-client.js',
      'promise-client.js',
      'bufbuild/connect/callback-client',
      'bufbuild/connect/promise-client',
      'callback-client',
      'promise-client',
    ];
    const found = anchors.find(a => wb.includes(a));
    if (found) {
      console.log(ok(`Inject anchor (${label}): "${found}"`));
    } else {
      console.log(fail(`Inject anchor (${label}) not found`));
      allOk = false;
    }
  }

  // 2. Signature bypass pattern
  if (existsSync(paths.extensionHostJs)) {
    const eh = readFileSync(paths.extensionHostJs, 'utf-8');
    const hasSigPattern = /if\(!\w\.valid\)/.test(eh);
    const alreadyBypassed = eh.includes('if(!1)') && !hasSigPattern;
    if (hasSigPattern || alreadyBypassed) {
      console.log(ok(`Sig bypass: ${alreadyBypassed ? 'already applied' : 'pattern found'}`));
    } else {
      console.log(fail('Sig bypass pattern not found'));
      allOk = false;
    }
  }

  // 3. Legacy Agent process: executable HTTP/1.1 router + wait
  const alwaysLocalOk = checkAlwaysLocalPatch(paths, s => console.log(info(s)));
  if (!alwaysLocalOk) allOk = false;

  // 4. Independent Agent Host process (3.13+): semantic network target + no WebSocket
  console.log(info('[check] Verifying cursor-agent-host transport coverage...'));
  const agentHostOk = checkAgentHostPatch(paths, s => console.log(info(s)));
  if (!agentHostOk) allOk = false;

  // 5. Cursor 3.9+ singleton BYOK router/proxy target
  if (needsProxy39Patch(paths)) {
    console.log(info('[check] Verifying Cursor 3.9 singleton BYOK router/proxy patch target...'));
    const proxyOk = checkProxy39Patch(paths, s => console.log(info(s)));
    if (!proxyOk) allOk = false;
  } else {
    console.log(info('Cursor 3.9 singleton BYOK router/proxy patch not required'));
  }

  // 6. cursor-always-local main.js
  if (existsSync(paths.alwaysLocalMain)) {
    console.log(ok('cursor-always-local main.js found'));
  } else {
    console.log(fail('cursor-always-local main.js not found'));
    allOk = false;
  }

  console.log();
  if (allOk) {
    console.log(ok('All patch targets matchable'));
  } else {
    console.log(fail('Some targets not matchable — install may fail'));
  }
}
