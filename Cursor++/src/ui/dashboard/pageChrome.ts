/**
 * Usage Dashboard 页面骨架 — 共享模板
 *
 * 两种宿主共用同一份 HTML + CSS:
 *   - webview 面板 (usage-dashboard.ts): inlineJs 内联转义后的 dashboard.js
 *   - 浏览器页 (server /byok/usage): scriptSrc 外链 /byok/usage.js,
 *     并注入 :root 主题默认值 (浏览器没有 --vscode-* 变量, 缺了会裸奔)
 *
 * inlineJs 的 </script> / <!-- 转义由调用方负责 (webview 侧沿用
 * panel-provider.ts 的注入模式), 本模块只做组装。
 */

export interface DashboardPageOptions {
  /** 内联脚本 (需已做 </script> / <!-- 转义) — webview 面板用; 与 scriptSrc 二选一 */
  inlineJs?: string
  /** 外链脚本地址 — 浏览器页用; 与 inlineJs 二选一, 缺省 /byok/usage.js */
  scriptSrc?: string
  /** 追加浏览器主题默认值 (:root 暗色 + prefers-color-scheme: light 覆盖) */
  includeBrowserThemeDefaults: boolean
}

/** 浏览器页暗色主题默认值 — 取 VS Code Dark+ 标准值, 覆盖页面用到的全部 --vscode-* 变量 */
const BROWSER_THEME_DARK_DEFAULTS = `  :root {
    --vscode-font-family: -apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, 'Ubuntu', 'Droid Sans', sans-serif;
    --vscode-font-size: 13px;
    --vscode-foreground: #cccccc;
    --vscode-editor-background: #1e1e1e;
    --vscode-panel-border: #2b2b2b;
    --vscode-descriptionForeground: #9d9d9d;
    --vscode-button-background: #0e639c;
    --vscode-button-foreground: #ffffff;
    --vscode-button-secondaryBackground: #3a3d41;
    --vscode-button-secondaryForeground: #ffffff;
    --vscode-editor-widget-background: #252526;
    --vscode-editor-font-family: Menlo, Monaco, 'Courier New', monospace;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --vscode-foreground: #3b3b3b;
      --vscode-editor-background: #ffffff;
      --vscode-panel-border: #e5e5e5;
      --vscode-descriptionForeground: #616161;
      --vscode-button-background: #007acc;
      --vscode-button-foreground: #ffffff;
      --vscode-button-secondaryBackground: #f0f0f0;
      --vscode-button-secondaryForeground: #3b3b3b;
      --vscode-editor-widget-background: #f8f8f8;
    }
  }
`

/** 页面主体 CSS — webview (有真实 vscode 变量) 与浏览器页 (走 :root 默认值) 共用 */
const PAGE_CSS = `  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    padding: 16px 20px 28px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  .toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .pills { display: flex; gap: 6px; flex-wrap: wrap; }
  .pill {
    padding: 3px 12px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 999px;
    background: transparent;
    color: var(--vscode-foreground);
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
    opacity: 0.85;
  }
  .pill:hover { opacity: 1; }
  .pill.active {
    background: var(--vscode-button-background);
    border-color: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    opacity: 1;
  }
  .refresh-btn {
    margin-left: auto;
    padding: 3px 12px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .refresh-btn:disabled { opacity: 0.5; cursor: default; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-bottom: 16px; }
  .summary-card {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    padding: 10px 14px;
    background: var(--vscode-editor-widget-background, transparent);
  }
  .summary-card .label { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
  .summary-card .value { font-size: 20px; font-weight: 600; }
  .section { margin-bottom: 20px; }
  .section-title { font-size: 12px; font-weight: 600; color: var(--vscode-descriptionForeground); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.04em; }
  .chart-box { position: relative; height: 280px; }
  .chart-split { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 720px) { .chart-split { grid-template-columns: 1fr; } }
  .chart-split .chart-box { height: 240px; }
  table.usage-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  table.usage-table th, table.usage-table td {
    padding: 6px 10px;
    text-align: right;
    border-bottom: 1px solid var(--vscode-panel-border);
    white-space: nowrap;
  }
  table.usage-table th:first-child, table.usage-table td:first-child,
  table.usage-table th:nth-child(2), table.usage-table td:nth-child(2) { text-align: left; }
  table.usage-table th { color: var(--vscode-descriptionForeground); font-weight: 600; position: sticky; top: 0; background: var(--vscode-editor-background); }
  table.usage-table td.model-cell { font-family: var(--vscode-editor-font-family, monospace); }
  .empty-state { padding: 64px 0; text-align: center; color: var(--vscode-descriptionForeground); }
  .empty-state .title { font-size: 15px; margin-bottom: 6px; color: var(--vscode-foreground); }
`

export function renderDashboardPageHtml(options: DashboardPageOptions): string {
  // CSP 按变体区分:
  //   inlineJs (webview) — 与抽模板前完全一致, 只放行内联脚本 (webview 不发 fetch)
  //   scriptSrc (浏览器) — 需放行同源脚本 + 同源 fetch (取数 /byok/usage-stats)
  const usesInlineScript = options.inlineJs !== undefined
  const contentSecurityPolicy = usesInlineScript
    ? `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';`
    : `default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self';`
  const scriptTag = usesInlineScript
    ? `<script>${options.inlineJs}</script>`
    : `<script src="${options.scriptSrc || '/byok/usage.js'}"></script>`
  const themeDefaults = options.includeBrowserThemeDefaults ? BROWSER_THEME_DARK_DEFAULTS : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">
<title>Cursor++ Usage</title>
<style>
${themeDefaults}${PAGE_CSS}</style>
</head>
<body>
<div id="app"></div>
${scriptTag}
</body>
</html>`
}
