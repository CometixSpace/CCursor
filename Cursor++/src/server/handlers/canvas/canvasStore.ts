/**
 * Canvas 存储 — Self-hosted Shared Canvas
 *
 * 接收 DashboardService.ShareCanvas 的 app_js + data_json，
 * 存储到 ~/.ccursor/canvases/{share_id}/，生成可直接 serve 的目录结构。
 *
 * 文件结构:
 *   ~/.ccursor/canvases/{share_id}/
 *     ├─ index.html      ← 壳页面 (加载 runtime + app.js)
 *     ├─ app.js           ← 编译后的 canvas React 应用
 *     ├─ data.json        ← canvas 状态数据
 *     ├─ runtime.js       ← canvas-runtime (从 cursor-agent-exec 复制)
 *     └─ meta.json        ← 元数据 (title, canvasKey, createdAt)
 *
 * 使用: npx serve ~/.ccursor/canvases/{share_id}
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getCcursorDir } from '../../config/paths'
import { logger } from '../../logger'

const CANVASES_DIR = 'canvases'

export function getCanvasesDir(): string {
  return join(getCcursorDir(), CANVASES_DIR)
}

function getCanvasDir(shareId: string): string {
  return join(getCanvasesDir(), shareId)
}

function generateShareId(): string {
  return `canvas-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * 把一段 JSON 文本嵌进内联 <script> 前必须做的转义。
 *
 * HTML 解析器在遇到 `</script` 时就结束脚本块,不管它出现在 JS 字符串字面量里。
 * canvas 的 data.json 是用户/模型产出的内容,只要任意字符串值里含 `</script>`
 * (或 `<!--`),导出的单文件 HTML 就会被截断,后半段作为 DOM 解析。
 *
 * JSON 里 `<` 只可能出现在字符串字面量内部,换成 `\u003c` 语义完全等价。
 */
function escapeJsonForInlineScript(json: string): string {
  return json.replace(/</g, '\\u003c')
}

export interface CanvasMeta {
  shareId: string
  title: string
  canvasKey?: string
  createdAt: string
  dir: string
}

function buildIndexHtml(title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>*{margin:0;padding:0;box-sizing:border-box;scrollbar-width:thin;scrollbar-color:rgba(121,121,121,0.4) transparent}html,body{min-height:100vh}body{padding:24px 32px}#root{min-height:calc(100vh - 48px);width:100%;margin:0 auto;overflow-x:auto;position:relative;contain:paint}::-webkit-scrollbar{width:8px;height:8px;background:transparent}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:rgba(121,121,121,0.4);border-radius:4px}::-webkit-scrollbar-thumb:hover{background:rgba(121,121,121,0.7)}::-webkit-scrollbar-corner{background:transparent}.canvas-loading{display:flex;align-items:center;justify-content:center;height:100vh;opacity:0.5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}</style>
</head>
<body>
<div id="root"><div class="canvas-loading">Loading canvas...</div></div>
<script>
  window.__cursorCanvas = {
    canvasId: "shared",
    data: new Map(),
    state: new Map([["theme", { kind: "light" }]]),
  };
</script>
<script type="module">
  async function boot() {
    const res = await fetch("./bundle.gz");
    const ds = new DecompressionStream("gzip");
    const reader = res.body.pipeThrough(ds).getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const text = new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
    const bundle = JSON.parse(text);
    const rtBlob = new Blob([bundle.runtimeEsm], { type: "text/javascript" });
    const rtUrl = URL.createObjectURL(rtBlob);
    const { mountCanvas } = await import(rtUrl);
    const appBlob = new Blob([bundle.userModule], { type: "text/javascript" });
    const appUrl = URL.createObjectURL(appBlob);
    await mountCanvas(appUrl);
  }
  boot().catch(e => {
    document.getElementById("root").innerHTML =
      '<div class="canvas-loading" style="color:#f44;">Error: ' + e.message + '</div>';
  });
</script>
</body>
</html>`
}

/**
 * 导出单文件 HTML — gzip bundle base64 内嵌，浏览器端解压 + 内联执行。
 *
 * 不使用 import() / blob URL（file:// 协议下受 CORS 限制）。
 * 改为：runtime 去 export → 挂 window.__canvasRuntime，
 *        userModule 去 export → 挂 window.__canvasApp，
 *        boot 脚本直接从 window 取引用执行 mountCanvas。
 *
 * 离线可用，file:// 直接打开即可。
 */
export function exportCanvasHtml(params: {
  title: string
  appJsGzip: Uint8Array
  dataJson: Uint8Array
}): string {
  const bundleB64 = Buffer.from(params.appJsGzip).toString('base64')
  const dataJsonStr = Buffer.from(params.dataJson).toString('utf-8')
  return buildSingleFileHtml(params.title, bundleB64, dataJsonStr)
}

function buildSingleFileHtml(title: string, bundleBase64: string, dataJson: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>*{margin:0;padding:0;box-sizing:border-box;scrollbar-width:thin;scrollbar-color:rgba(121,121,121,0.4) transparent}html,body{min-height:100vh}body{padding:24px 32px}#root{min-height:calc(100vh - 48px);width:100%;margin:0 auto;overflow-x:auto;position:relative;contain:paint}::-webkit-scrollbar{width:8px;height:8px;background:transparent}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:rgba(121,121,121,0.4);border-radius:4px}::-webkit-scrollbar-thumb:hover{background:rgba(121,121,121,0.7)}::-webkit-scrollbar-corner{background:transparent}.canvas-loading{display:flex;align-items:center;justify-content:center;height:100vh;opacity:0.5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}</style>
</head>
<body>
<div id="root"><div class="canvas-loading">Loading canvas...</div></div>
<script>
  window.__cursorCanvas = {
    canvasId: "exported",
    data: new Map(Object.entries(${escapeJsonForInlineScript(dataJson || '{}')})),
    state: new Map([["theme", { kind: "light" }]]),
  };
</script>
<script>
(async function() {
  try {
    var b64 = "${bundleBase64}";
    var bin = Uint8Array.from(atob(b64), function(c) { return c.charCodeAt(0); });
    var ds = new DecompressionStream("gzip");
    var writer = ds.writable.getWriter();
    writer.write(bin);
    writer.close();
    var reader = ds.readable.getReader();
    var chunks = [];
    while (true) {
      var r = await reader.read();
      if (r.done) break;
      chunks.push(r.value);
    }
    var text = new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
    var bundle = JSON.parse(text);

    // runtime: 去掉 ESM export → 改为赋值到 window
    var rtCode = bundle.runtimeEsm.replace(
      /export\\{([^}]*)\\}/,
      "window.__canvasRT={mountCanvas:mountCanvas};"
    );
    var rtEl = document.createElement("script");
    rtEl.textContent = rtCode;
    document.head.appendChild(rtEl);

    // userModule → data URI, 供 mountCanvas 的 import() 使用
    var appDataUri = "data:text/javascript;charset=utf-8," + encodeURIComponent(bundle.userModule);
    await window.__canvasRT.mountCanvas(appDataUri);
  } catch(e) {
    document.getElementById("root").innerHTML =
      '<div class="canvas-loading" style="color:#f44;">Error: ' + e.message + '</div>';
    console.error("[canvas-export]", e);
  }
})();
</script>
</body>
</html>`
}

export function storeCanvas(params: {
  title: string
  appJs: Uint8Array
  dataJson: Uint8Array
  canvasKey?: string
}): { shareId: string, dir: string } {
  const shareId = generateShareId()
  const dir = getCanvasDir(shareId)
  mkdirSync(dir, { recursive: true })

  // appJs 原样存储 (gzip 压缩的 JSON bundle)，浏览器端解压
  writeFileSync(join(dir, 'bundle.gz'), params.appJs)
  writeFileSync(join(dir, 'data.json'), params.dataJson)
  writeFileSync(join(dir, 'index.html'), buildIndexHtml(params.title))

  const meta: CanvasMeta = {
    shareId,
    title: params.title,
    canvasKey: params.canvasKey,
    createdAt: new Date().toISOString(),
    dir,
  }
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))

  logger.info({ shareId, title: params.title, dir, bundleSize: params.appJs.length }, '[CANVAS] stored')
  return { shareId, dir }
}

export function lookupCanvasByKey(canvasKey: string): CanvasMeta | null {
  const dir = getCanvasesDir()
  if (!existsSync(dir)) return null
  const { readdirSync } = require('node:fs') as typeof import('node:fs')
  for (const entry of readdirSync(dir)) {
    const metaPath = join(dir, entry, 'meta.json')
    if (!existsSync(metaPath)) continue
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as CanvasMeta
      if (meta.canvasKey === canvasKey) return meta
    }
    catch {}
  }
  return null
}
