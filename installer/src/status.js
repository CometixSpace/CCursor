/**
 * ccursor status — check install state
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { findCursorPathsDetailed, formatDiagnostic } from './detect.js';
import { isExtensionInstalled } from './extension-embed.js';
import { hasBackup } from './backup.js';
import { CCURSOR_DIR } from './routes.js';
import { PROVIDERS_FILE_NAME, ROUTES_FILE_NAME } from './defaults.js';
import { needsProxy39Patch, isProxy39Patched, getProxy39Target } from './patch-proxy-39.js';
import { inspectAlwaysLocalPatch } from './patch-always-local.js';
import { getAgentHostBackupTargets, inspectAgentHostPatch } from './patch-agent-host.js';
import { isInjectPatched } from './patch-inject.js';

const ok = s => `\x1b[32m✓ ${s}\x1b[0m`;
const fail = s => `\x1b[31m✗ ${s}\x1b[0m`;
const na = s => `\x1b[2m- ${s}\x1b[0m`;

export async function status() {
  const { paths, diagnostic } = findCursorPathsDetailed();
  if (!paths) {
    console.log(fail('Cursor installation not found'));
    console.log('');
    console.log(formatDiagnostic(diagnostic));
    return;
  }

  console.log(`Cursor: ${paths.appRoot}\n`);

  // Extension
  const extInstalled = isExtensionInstalled(paths);
  console.log(extInstalled ? ok('Extension installed') : fail('Extension not installed'));

  // Inject (desktop)
  if (existsSync(paths.workbenchJs)) {
    const wb = readFileSync(paths.workbenchJs, 'utf-8');
    const injected = isInjectPatched(wb);
    console.log(injected ? ok('Renderer hook injected (desktop)') : fail('Renderer hook not injected (desktop)'));
  } else {
    console.log(na('workbench.desktop.main.js not found'));
  }

  // Inject (glass / Agent Window)
  if (existsSync(paths.glassJs)) {
    const gl = readFileSync(paths.glassJs, 'utf-8');
    const injected = isInjectPatched(gl);
    console.log(injected ? ok('Renderer hook injected (glass)') : fail('Renderer hook not injected (glass)'));
  } else {
    console.log(na('workbench.glass.main.js not found (pre-3.8)'));
  }

  // Legacy Agent transport (cursor-always-local)
  const alwaysLocal = inspectAlwaysLocalPatch(paths);
  if (alwaysLocal.present) {
    console.log(alwaysLocal.router ? ok('Legacy Agent HTTP/1.1 router active') : fail('Legacy Agent HTTP/1.1 router missing'));
    console.log(alwaysLocal.wait ? ok('Legacy Agent server wait active') : fail('Legacy Agent server wait missing'));
    if (alwaysLocal.websocketRequired) {
      console.log(alwaysLocal.websocketDisabled
        ? ok('Legacy Agent WebSocket bypass disabled')
        : fail('Legacy Agent WebSocket bypass is active'));
    }
  }
  else {
    console.log(na('cursor-always-local not found'));
  }

  // Independent Agent Host transport (Cursor 3.13+)
  const agentHost = inspectAgentHostPatch(paths);
  if (!agentHost.present) {
    console.log(na('cursor-agent-host not found (pre-3.13)'));
  }
  else {
    console.log(agentHost.router ? ok('Agent Host HTTP/1.1 router active') : fail('Agent Host HTTP/1.1 router missing'));
    console.log(agentHost.wait ? ok('Agent Host server wait active') : fail('Agent Host server wait missing'));
    if (agentHost.turnRouteRequired) {
      console.log(agentHost.turnRoute
        ? ok('Agent Host turn router pinned to connect (3.19.19+ BYOK)')
        : fail('Agent Host turn router still routes to managed-local (3.19.19+ BYOK unreachable)'));
    }
    else if (agentHost.entryValid) {
      console.log(na('Agent Host local-loop turn router not present (pre-3.19.19 or non-entry chunk)'));
    }
    else {
      console.log(fail('Agent Host turn router state unknown (entry unreadable)'));
    }
    console.log(agentHost.networkTargets.length > 0
      ? ok(`Agent Host network target verified (${agentHost.networkTargets.map(file => file.split(/[\\/]/).pop()).join(', ')})`)
      : fail('Agent Host network target not found'));
    if (agentHost.websocketTargets.length > 0) {
      console.log(agentHost.websocketDisabled
        ? ok('Agent Host WebSocket bypass disabled')
        : fail('Agent Host WebSocket bypass is active'));
    }
    else {
      console.log(na('Agent Host WebSocket transport not present (3.13–3.15)'));
    }
  }

  // Sig bypass
  if (existsSync(paths.extensionHostJs)) {
    const eh = readFileSync(paths.extensionHostJs, 'utf-8');
    const bypassed = eh.includes('if(!1)') && !/if\(!\w\.valid\)/.test(eh);
    console.log(bypassed ? ok('Signature bypass active') : fail('Signature bypass not active'));
  } else {
    console.log(na('extensionHostProcess.js not found'));
  }

  // Cursor 3.9+ always-local singleton BYOK router/proxy sync
  if (needsProxy39Patch(paths)) {
    console.log(isProxy39Patched(paths) ? ok('Cursor 3.9 singleton BYOK router/proxy patch active') : fail('Cursor 3.9 singleton BYOK router/proxy patch missing'));
  } else if (existsSync(getProxy39Target(paths))) {
    console.log(na('Cursor 3.9 singleton BYOK router/proxy patch not required'));
  }

  // ~/.ccursor 资源
  console.log('');
  const routesPath = join(CCURSOR_DIR, ROUTES_FILE_NAME);
  const providersPath = join(CCURSOR_DIR, PROVIDERS_FILE_NAME);
  console.log(existsSync(routesPath) ? ok(`routes.json: ${routesPath}`) : fail(`routes.json missing at ${routesPath}`));
  console.log(existsSync(providersPath) ? ok(`providers.json: ${providersPath}`) : fail(`providers.json missing at ${providersPath}`));

  // Backups
  console.log('');
  const backupFiles = [...new Set([
    paths.workbenchJs,
    paths.glassJs,
    paths.alwaysLocalMain,
    paths.alwaysLocalSingletonJs,
    paths.extensionHostJs,
    paths.productJson,
    ...getAgentHostBackupTargets(paths),
  ])];
  const backupCount = backupFiles.filter(f => hasBackup(f)).length;
  console.log(`Backups: ${backupCount}/${backupFiles.length} files backed up`);
}
