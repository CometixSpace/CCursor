/**
 * Cursor Agent Host patch (3.13+).
 *
 * Agent Host runs in a dedicated Extension Host role, so the legacy
 * cursor-always-local process router cannot affect its independent transport.
 * This patch installs the shared HTTP/1.1 router in dist/main.js, waits for the
 * local server, and disables the Agent WebSocket selector. Cursor's existing
 * `cursor.general.disableHttp2` policy remains untouched.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import * as acorn from 'acorn';
import { createBackup } from './backup.js';
import { updateChecksums } from './checksum.js';
import { hasActivateWait, injectActivateWait } from './patch-always-local.js';
import { buildNodeHttp11RouterPayload, isNodeHttp11RouterPatched } from './node-http11-router.js';
import { enableNativeInference, NATIVE_LOOP_MARKER } from './native-loop-guard.js';
import {
  AGENT_WS_GATE_MARKER,
  AGENT_WS_ORIGINS_MARKER,
  disableAgentWebSocket,
  hasAgentWebSocketStack,
  isAgentWebSocketDisabled,
} from './agent-websocket-guard.js';

export { disableAgentWebSocket, hasAgentWebSocketStack, isAgentWebSocketDisabled };
const TAG = 'agent-host';
export const AGENT_HOST_ROUTER_MARKER = '__byokAgentHostUrlRewrite';
// Backward-compatible export names; new injections use topology-neutral markers.
export const AGENT_HOST_WS_GATE_MARKER = AGENT_WS_GATE_MARKER;
export const AGENT_HOST_WS_ORIGINS_MARKER = AGENT_WS_ORIGINS_MARKER;

const ENTRY_FINGERPRINTS = [
  'cursorAgentHostEnabled',
  'registerAgentHostProvider',
  'Activating agent host extension',
];
const NETWORK_FINGERPRINTS = [
  'agent.v1.AgentService',
  'RunSSE',
  'BidiAppend',
  'AiConnectTransportHandler',
  'HTTP/1.1 transport created with network settings',
];

function parseBundle(source, label) {
  try {
    return acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  }
  catch (error) {
    throw new Error(`${label} JavaScript parse failed: ${error.message}`);
  }
}

function agentHostDist(paths) {
  return paths.agentHostDist || dirname(paths.agentHostMain);
}

export function hasAgentHost(paths) {
  return Boolean(paths.agentHostMain && existsSync(paths.agentHostMain));
}

function hasValidPackage(paths) {
  const packagePath = paths.agentHostPackageJson || join(dirname(agentHostDist(paths)), 'package.json');
  if (!existsSync(packagePath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(packagePath, 'utf-8'));
    return pkg.name === 'cursor-agent-host' && pkg.publisher === 'anysphere' && pkg.main === './dist/main.js';
  }
  catch {
    return false;
  }
}

export function isAgentHostEntry(source) {
  return ENTRY_FINGERPRINTS.every(fingerprint => source.includes(fingerprint));
}

export function isAgentHostNetworkSource(source) {
  return NETWORK_FINGERPRINTS.every(fingerprint => source.includes(fingerprint));
}

function listDistJavaScript(paths) {
  const dist = agentHostDist(paths);
  if (!existsSync(dist)) return [];
  return readdirSync(dist, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.unminify.js'))
    .map(entry => join(dist, entry.name));
}

export function findAgentHostNetworkTargets(paths) {
  const targets = [];
  for (const file of listDistJavaScript(paths)) {
    const source = readFileSync(file, 'utf-8');
    if (isAgentHostNetworkSource(source)) targets.push(file);
  }
  return targets;
}

function buildAgentHostRouter() {
  return buildNodeHttp11RouterPayload({
    guardMarker: AGENT_HOST_ROUTER_MARKER,
    processLabel: 'agent-host',
  });
}

function prepareAgentHostPatch(paths, log) {
  if (!hasValidPackage(paths)) throw new Error('cursor-agent-host package fingerprint mismatch');

  const originalEntry = readFileSync(paths.agentHostMain, 'utf-8');
  if (!isAgentHostEntry(originalEntry)) throw new Error('cursor-agent-host entry fingerprint mismatch');

  const networkTargets = findAgentHostNetworkTargets(paths);
  if (networkTargets.length === 0) throw new Error('Agent Host network transport chunk not found by content fingerprint');

  const originalByFile = new Map();
  for (const file of new Set([paths.agentHostMain, ...networkTargets])) {
    originalByFile.set(file, readFileSync(file, 'utf-8'));
  }
  const patchedByFile = new Map(originalByFile);

  let entry = patchedByFile.get(paths.agentHostMain);
  if (!isNodeHttp11RouterPatched(entry, AGENT_HOST_ROUTER_MARKER)) {
    entry = buildAgentHostRouter() + entry;
    log?.('  Agent Host HTTP/1.1 whitelist router injected');
  }

  const waited = injectActivateWait(entry, 'agent-host', log);
  if (!waited.ok) throw new Error('cursor-agent-host activate function not found');
  entry = waited.source;
  if (entry.includes('byok-connect-routed') && entry.includes('agent_host_local_loop')) {
    entry = enableNativeInference(entry).source;
  }
  patchedByFile.set(paths.agentHostMain, entry);

  let websocketTargets = 0;
  for (const file of networkTargets) {
    const source = patchedByFile.get(file);
    if (!hasAgentWebSocketStack(source)) continue;
    websocketTargets++;
    const disabled = disableAgentWebSocket(source, basename(file));
    patchedByFile.set(file, disabled.source);
    log?.(`  Agent WebSocket disabled in content-matched chunk: ${basename(file)}`);
  }

  for (const [file, source] of patchedByFile) {
    if (source !== originalByFile.get(file)) parseBundle(source, basename(file));
  }

  return { originalByFile, patchedByFile, networkTargets, websocketTargets };
}

export function patchAgentHost(paths, log) {
  if (!hasAgentHost(paths)) {
    log?.('[agent-host] Not present (Cursor < 3.13), skipping');
    return false;
  }

  log?.('[agent-host] Patching independent Agent Host transport...');
  const prepared = prepareAgentHostPatch(paths, log);
  const modified = [];

  for (const [file, source] of prepared.patchedByFile) {
    if (source === prepared.originalByFile.get(file)) continue;
    createBackup(file, TAG, log);
    writeFileSync(file, source);
    modified.push(file);
  }

  if (modified.length === 0) {
    log?.('[agent-host] Already fully patched');
    return false;
  }

  updateChecksums(paths, modified, TAG, log);
  log?.(`[agent-host] Done (${modified.length} file(s), ${prepared.networkTargets.length} network chunk(s), ${prepared.websocketTargets} WebSocket chunk(s))`);
  return true;
}

export function inspectAgentHostPatch(paths) {
  if (!hasAgentHost(paths)) {
    return {
      present: false,
      required: false,
      fullyPatched: true,
      entryValid: true,
      router: true,
      wait: true,
      networkTargets: [],
      websocketTargets: [],
      websocketDisabled: true,
      errors: [],
    };
  }

  const errors = [];
  const packageValid = hasValidPackage(paths);
  if (!packageValid) errors.push('package fingerprint mismatch');
  let entry = '';
  try { entry = readFileSync(paths.agentHostMain, 'utf-8'); }
  catch (error) { errors.push(error.message); }

  const entryValid = Boolean(entry) && isAgentHostEntry(entry);
  if (!entryValid) errors.push('entry fingerprint mismatch');
  const router = Boolean(entry) && isNodeHttp11RouterPatched(entry, AGENT_HOST_ROUTER_MARKER);
  const wait = Boolean(entry) && hasActivateWait(entry);
  const nativeLoopRequired = entry.includes('byok-connect-routed') && entry.includes('agent_host_local_loop');
  const nativeLoop = !nativeLoopRequired || entry.includes(`/*${NATIVE_LOOP_MARKER}*/`);

  let networkTargets = [];
  try { networkTargets = findAgentHostNetworkTargets(paths); }
  catch (error) { errors.push(error.message); }
  if (networkTargets.length === 0) errors.push('network transport chunk not found');

  const websocketTargets = [];
  let websocketDisabled = true;
  for (const file of networkTargets) {
    try {
      const source = readFileSync(file, 'utf-8');
      if (!hasAgentWebSocketStack(source)) continue;
      websocketTargets.push(file);
      if (!isAgentWebSocketDisabled(source, basename(file))) websocketDisabled = false;
    }
    catch (error) {
      websocketDisabled = false;
      errors.push(error.message);
    }
  }

  const fullyPatched = packageValid && entryValid && router && wait && nativeLoop
    && networkTargets.length > 0 && websocketDisabled && errors.length === 0;
  return {
    present: true,
    required: true,
    fullyPatched,
    entryValid,
    router,
    wait,
    nativeLoop,
    networkTargets,
    websocketTargets,
    websocketDisabled,
    errors,
  };
}

export function isAgentHostPatched(paths) {
  return inspectAgentHostPatch(paths).fullyPatched;
}

export function checkAgentHostPatch(paths, log) {
  if (!hasAgentHost(paths)) {
    log?.('  cursor-agent-host not present (pre-3.13, not required)');
    return true;
  }

  const current = inspectAgentHostPatch(paths);
  if (current.fullyPatched) {
    log?.(`  Already patched: entry + ${current.networkTargets.length} content-matched network chunk(s)`);
    return true;
  }

  try {
    const prepared = prepareAgentHostPatch(paths, log);
    log?.(`  [OK] Agent Host entry/router/activate target found`);
    log?.(`  [OK] ${prepared.networkTargets.length} network chunk(s) found by semantic fingerprints`);
    log?.(`  [OK] ${prepared.websocketTargets} WebSocket chunk(s) can be disabled`);
    return true;
  }
  catch (error) {
    log?.(`  [FAIL] ${error.message}`);
    return false;
  }
}

/** Discover original paths from tagged backups without relying on chunk IDs. */
export function getAgentHostBackupTargets(paths) {
  const targets = new Set();
  if (paths.agentHostMain) targets.add(paths.agentHostMain);
  const dist = agentHostDist(paths);
  if (!existsSync(dist)) return [...targets];
  const marker = `.backup-byok-${TAG}-`;
  for (const entry of readdirSync(dist, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const index = entry.name.indexOf(marker);
    if (index > 0) targets.add(join(dist, entry.name.slice(0, index)));
  }
  return [...targets].sort();
}
