/**
 * Agent Window (glass) 模型目录刷新 — 与 IDE 窗口复用同一条刷新链路
 *
 * 目标:
 *   glass 的模型列表语义要和 IDE 窗口完全一致：选择器打开时是 Auto/routed 视图，
 *   关掉 Auto 显示当前目录（可能还是官方快照），点刷新后变成 providers.json 的列表。
 *
 * 背景:
 *   glass 的刷新按钮（`title="Refresh model list"`）走的是原生路径
 *   `aiService.refreshDefaultModels()`，和 IDE 窗口用 BYOK 按钮调的是**同一个方法**。
 *   但 glass 窗口的 cursorAuthenticationService 常常处于未认证状态，方法入口直接
 *   return，一个请求都不发 —— 表现就是"点了刷新没反应"。
 *
 *   这个方法从 3.19.19 起就有，但守卫的参数在各版本间变过
 *   （3.21.18 / 3.22.12 是 `trySeedCatalogFromOwnKey(),watchPrivateInferenceCatalog(),!isAuthenticated()`，
 *   其它版本没有中间那一步）。用精确字面量做锚点会在这两版直接失配，
 *   所以这里只按"入口签名 + 守卫指纹"定位，再在原位插入/包裹，不改写守卫本身。
 *
 * 实现（只做一件事）:
 *   在 refreshDefaultModels 入口跳过未认证的提前返回，前提是
 *   `globalThis.__byokForceRefresh` 为 true —— 该标记由 renderer hook 在用户点击
 *   刷新按钮时置位（见 patch-inject.js 的 glassNativeRefresh）。真正的模型目录请求
 *   由 hook 在 transport 层短路到本地 Cursor++ 服务（见 __byokFetchLocalAvailableModels）。
 *
 * 只在 glass bundle 上应用；desktop（IDE 窗口）保持原逻辑。
 */
import * as acorn from 'acorn';

export const GLASS_FORCE_REFRESH_MARKER = '__byokForceRefresh';
const SOURCE_MARKER = '/* BYOK-GLASS-REFRESH */';

const REFRESH_ENTRY = 'async refreshDefaultModels(){';
// 入口之后 240 字符内必须同时出现这两个调用，才算"带目录种子 + 认证守卫"的那一处实现。
const REFRESH_GUARD_FINGERPRINTS = ['trySeedCatalogFromOwnKey()', 'isAuthenticated()'];
const REFRESH_GUARD_WINDOW = 240;
const UNAUTH_GUARD = '!this._cursorAuthenticationService.isAuthenticated()';
const ENTRY_PAYLOAD = `${SOURCE_MARKER}try{globalThis.__byokAiSvc=this}catch(__byokErr){}`;

export function isGlassRefreshPatched(source) {
  return source.includes(SOURCE_MARKER) && source.includes(`globalThis.${GLASS_FORCE_REFRESH_MARKER}`);
}

function findRefreshEntries(source) {
  const entries = [];
  let position = source.indexOf(REFRESH_ENTRY);
  while (position !== -1) {
    const guard = source.slice(position, position + REFRESH_GUARD_WINDOW);
    if (REFRESH_GUARD_FINGERPRINTS.every(fingerprint => guard.includes(fingerprint)))
      entries.push(position);
    position = source.indexOf(REFRESH_ENTRY, position + 1);
  }
  return entries;
}

/**
 * @param {string} source glass workbench bundle 源码
 * @param {(msg: string) => void} [log]
 */
export function patchGlassModelRefresh(source, log) {
  if (isGlassRefreshPatched(source))
    return { source, patched: false };

  const entries = findRefreshEntries(source);
  if (entries.length !== 1)
    throw new Error(`glass refresh anchor matched ${entries.length} times (expected 1)`);

  const entryEnd = entries[0] + REFRESH_ENTRY.length;
  const withPayload = source.slice(0, entryEnd) + ENTRY_PAYLOAD + source.slice(entryEnd);

  const guardAt = withPayload.indexOf(UNAUTH_GUARD, entryEnd);
  if (guardAt === -1 || guardAt > entryEnd + REFRESH_GUARD_WINDOW + ENTRY_PAYLOAD.length)
    throw new Error('glass refresh unauthenticated guard not found inside entry window');

  const patched = withPayload.slice(0, guardAt) + `!globalThis.${GLASS_FORCE_REFRESH_MARKER}&&` + withPayload.slice(guardAt);

  try {
    acorn.parse(patched, { ecmaVersion: 'latest', sourceType: 'module' });
  }
  catch (error) {
    throw new Error(`glass refresh patch failed to parse: ${error.message}`);
  }

  log?.('  Model refresh: BYOK bypass for unauthenticated glass window');
  return { source: patched, patched: true };
}
