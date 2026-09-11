/**
 * Release default resources to ~/.ccursor/ during installation.
 *
 * Existing routes.json and providers.json are kept without reading or rewriting
 * them. New routes start with BYOK OFF so login and onboarding can finish before
 * the user enables BYOK. Cursor's authentication database is never inspected.
 *
 * The bundled models-catalog.json snapshot is still copied with overwrite.
 */
import { existsSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  MODELS_CATALOG_FILE_NAME,
  PROVIDERS_FILE_NAME,
  ROUTES_FILE_NAME,
  WEB_TOOLS_FILE_NAME,
  DEFAULT_PROVIDERS,
  DEFAULT_ROUTES,
  DEFAULT_WEB_TOOLS,
  BASE_REDIRECT,
} from './defaults.js';
import { CCURSOR_DIR } from './routes.js';

function release(filename, content, log) {
  const dest = join(CCURSOR_DIR, filename);
  try {
    // Exclusive creation also preserves files created by another process.
    writeFileSync(dest, JSON.stringify(content, null, 2) + '\n', { encoding: 'utf-8', flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    log?.(`  ${filename} already exists, keep`);
    return false;
  }
  log?.(`  ${filename} released`);
  return true;
}

// 打包后 __dirname 指向 cli.cjs 所在目录 (installer/dist/),
// 与之同级存放 models-catalog.json (esbuild.js 构建时复制)。
// 开发模式从 src/ 直接跑时 fallback 到 src/../assets/
function resolveAssetPath(filename) {
  const candidates = [
    join(__dirname, filename),                  // bundled: dist/<file>
    join(__dirname, '..', 'assets', filename),  // dev: src/../assets/<file>
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function copyAsset(filename, log, { force = false } = {}) {
  const dest = join(CCURSOR_DIR, filename);
  if (!force && existsSync(dest)) {
    log?.(`  ${filename} already exists, keep`);
    return false;
  }
  const src = resolveAssetPath(filename);
  if (!src) {
    log?.(`  ${filename} asset not bundled, skip`);
    return false;
  }
  const existed = existsSync(dest);
  copyFileSync(src, dest);
  const size = (readFileSync(dest).length / 1024).toFixed(1);
  log?.(`  ${filename} ${existed ? 'updated' : 'released'} (${size} KB)`);
  return true;
}

export function releaseDefaults(log) {
  log?.('[defaults] Releasing to ~/.ccursor/...');
  mkdirSync(CCURSOR_DIR, { recursive: true });

  const routes = {
    ...DEFAULT_ROUTES,
    byokMode: 0,
    redirect: [...BASE_REDIRECT],
  };
  if (release(ROUTES_FILE_NAME, routes, log)) {
    log?.('  BYOK is OFF by default; enable BYOK after completing Cursor login and onboarding.');
  }
  release(PROVIDERS_FILE_NAME, DEFAULT_PROVIDERS, log);
  release(WEB_TOOLS_FILE_NAME, DEFAULT_WEB_TOOLS, log);
  copyAsset(MODELS_CATALOG_FILE_NAME, log, { force: true });

  log?.('[defaults] Done');
}
