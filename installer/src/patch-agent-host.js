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

/**
 * Local-loop turn router (Cursor 3.19.19+).
 *
 * Cursor 在两种运行时之间路由每个 turn:
 *   - connect       → 旧 `agent.v1.AgentService/RunSSE`,本地 BYOK server 已实现
 *   - managed-local → 新增 `aiserver.v1.InferenceService/RunInferenceSSE`,本地未实现
 *
 * 判定条件里有一条 `hasModelCredentials`(Cursor 原生 BYOK 的 apiKey 凭据):
 * 带凭据的模型会被打成 `byok-connect-routed` 走 connect;而我们的模型来自
 * `AvailableModels` stub,不带凭据,于是被判为 eligible 走 managed-local。
 * 请求随后直发官方 api2.cursor.sh,本地 server 完全收不到 → Agent 一直转圈。
 * 是否真的走到这一步取决于 managedLocalAvailable / `agent_host_local_loop`
 * gate(客户端默认 false) / enrollmentLatch,所以同一版本在不同机器上表现可能不同。
 *
 * 版本边界(按 chunk 扫描确认,只看 dist/main.js 会误判):
 *   - 3.16.29 起 `{runtime:"managed-local",reason:"eligible"}` 就存在,但在懒加载
 *     chunk 里(985.js / 478.js / 61.js),logger 名为 `@anysphere/agent-host:turn-routing`;
 *   - 3.19.19 才搬进 dist/main.js,logger 同时改名为 `local-loop-turn-router`;
 *   - 凭据旁路 `byok-connect-routed` 直到 3.24.18 才加入,在此之前带凭据的模型是
 *     `fail: private-model-not-supported`,不带凭据才落到 managed-local。
 *   本补丁只改写 dist/main.js,所以覆盖范围是 3.19.19+,更早的版本会按"未出现"跳过。
 *
 * 这里把 eligible 的最终判定改为 connect,与原生 BYOK 的分支保持一致。
 *
 * 版本识别分三层,避免"新版锚点变了却静默当成旧版跳过":
 *   1. TURN_ROUTER_FINGERPRINT —— 路由模块的 logger 名,3.19.19+ 恒存在。
 *      不存在 = 该版本把代码拆在懒加载 chunk 里或根本无此分支,直接跳过。
 *   2. 存在指纹但锚点匹配不到 = 该版本改过路由代码,抛错让 check/update
 *      失败并回滚,而不是假装已适配。
 *   3. 锚点本身用容错正则(允许空白/引号风格/键顺序),不用精确字面量。
 */
export const TURN_ROUTER_FINGERPRINT = '@anysphere/agent-host:local-loop-turn-router';
export const CONNECT_TURN_ROUTE = '{runtime:"connect",reason:"byok-connect-routed",disposition:"fallback"}';

// 匹配 { ... runtime:"managed-local" ... reason:"eligible" ... }，任意键顺序与空白。
// 负向条件: private-inference 分支的 reason 是 "private-inference-eligible"，天然不匹配。
const MANAGED_LOCAL_ELIGIBLE_ROUTE_RE
  = /\{(?=[^{}]*runtime\s*:\s*["']managed-local["'])(?=[^{}]*reason\s*:\s*["']eligible["'])[^{}]*\}/g;

export function hasTurnRouter(source) {
  return source.includes(TURN_ROUTER_FINGERPRINT);
}

export function isConnectTurnRoutePinned(source) {
  return source.includes(CONNECT_TURN_ROUTE);
}

export function countEligibleTurnRoutes(source) {
  const re = new RegExp(MANAGED_LOCAL_ELIGIBLE_ROUTE_RE.source, 'g');
  let count = 0;
  while (re.exec(source) !== null) count++;
  return count;
}

export function forceConnectTurnRoute(source) {
  const required = hasTurnRouter(source);
  if (!required) return { changed: false, matched: isConnectTurnRoutePinned(source), required: false, source };
  const pinned = isConnectTurnRoutePinned(source);
  const replaced = source.replace(new RegExp(MANAGED_LOCAL_ELIGIBLE_ROUTE_RE.source, 'g'), CONNECT_TURN_ROUTE);
  const changed = replaced !== source;
  return { changed, matched: pinned || changed, required: true, source: replaced };
}

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

  const routed = forceConnectTurnRoute(entry);
  const turnRouteRequired = routed.required;
  if (routed.required && !routed.matched) {
    // 路由模块在,但 managed-local eligible 分支的形状变了 —— 不能装作适配成功。
    throw new Error('cursor-agent-host local-loop turn router shape changed: managed-local eligible route anchor not found (this Cursor version needs an updated patch)');
  }
  if (routed.changed) log?.('  Agent Host turn router pinned to backend loop (connect)');
  else if (!routed.required) log?.('  Agent Host local-loop turn router not present (pre-3.19.19 or non-entry chunk), skipping');
  entry = routed.source;
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

  return { originalByFile, patchedByFile, networkTargets, websocketTargets, turnRouteRequired };
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
      turnRoute: true,
      turnRouteRequired: false,
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
  // 用路由模块指纹判断该版本是否带这段代码;没有指纹 = pre-3.19.19 或代码在
  // 懒加载 chunk 里,视为无需此补丁。
  // 有指纹时必须"已钉住且锚点已清零",否则视为未打(或版本漂移)。
  const turnRouteRequired = Boolean(entry) && hasTurnRouter(entry);
  const turnRoute = !turnRouteRequired
    || (isConnectTurnRoutePinned(entry) && countEligibleTurnRoutes(entry) === 0);
  if (turnRouteRequired && !turnRoute) errors.push('local-loop turn router not pinned to connect');

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

  const fullyPatched = packageValid && entryValid && router && wait && turnRoute
    && networkTargets.length > 0 && websocketDisabled && errors.length === 0;
  return {
    present: true,
    required: true,
    fullyPatched,
    entryValid,
    router,
    wait,
    turnRoute,
    turnRouteRequired,
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
    log?.(prepared.turnRouteRequired
      ? '  [OK] local-loop turn router anchor found (3.19.19+ BYOK)'
      : '  [OK] local-loop turn router not required (pre-3.19.19 or non-entry chunk)');
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
