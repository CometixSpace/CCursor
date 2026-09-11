/**
 * Usage Dashboard — 每模型 Token 用量统计面板 (独立 webview panel)
 *
 * 与侧边栏 Control Panel 完全独立:
 *   - 模块级单例: 已打开则 reveal(), 关闭后清引用
 *   - HTML 生成复用 panel-provider.ts 的注入模式: dist/dashboard.js 内联
 *     (同样做 </script> / <!-- 转义, 同样缓存到模块变量)
 *   - 数据不经 webview 直接 fetch server, 而是 postMessage → extension host
 *     转发 (兼容 server 跑在另一个窗口进程的 remote 场景)
 *   - 页面骨架抽至 dashboard/pageChrome.ts, 与 server 伺服的浏览器版共用
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as vscode from 'vscode'
import { getServerConfig } from '../server/config'
import { logger } from '../server/logger'
import { renderDashboardPageHtml } from './dashboard/pageChrome'

let dashboardPanel: vscode.WebviewPanel | null = null
let dashboardJsCache: string | null = null

function getDashboardJs(extensionPath: string): string {
  if (!dashboardJsCache) {
    const raw = readFileSync(join(extensionPath, 'dist', 'dashboard.js'), 'utf-8')
    // 内联 <script> 安全转义: </script> 和 <!-- 会被 HTML 解析器截断
    dashboardJsCache = raw.replaceAll('</script>', '<\\/script>').replaceAll('<!--', '<\\!--')
  }
  return dashboardJsCache
}

/**
 * 打开 Usage Dashboard (单例): 已打开则 reveal, 否则创建新 panel。
 * 由命令 cursor2plus.openUsageDashboard 与状态栏 tooltip 链接调用。
 */
export function openUsageDashboard(context: vscode.ExtensionContext): void {
  if (dashboardPanel) {
    dashboardPanel.reveal()
    return
  }

  const panel = vscode.window.createWebviewPanel(
    'cursor2plus.usageDashboard',
    'Cursor++ Usage',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  )
  dashboardPanel = panel
  panel.webview.html = renderDashboardPageHtml({
    inlineJs: getDashboardJs(context.extensionPath),
    includeBrowserThemeDefaults: false,
  })

  // webview → host: fetchUsage 请求转发 — webview 内 fetch localhost 在
  // remote 态不可达, 由 extension host 统一请求后回发
  panel.webview.onDidReceiveMessage(async (msg: any) => {
    if (!msg || msg.type !== 'fetchUsage')
      return
    const range = typeof msg.range === 'string' ? msg.range : '7d'
    const requestId = msg.requestId
    try {
      const { host, port } = getServerConfig()
      const response = await fetch(
        `http://${host}:${port}/byok/usage-stats?range=${encodeURIComponent(range)}`,
        { signal: AbortSignal.timeout(5000) },
      )
      if (!response.ok)
        throw new Error(`HTTP ${response.status}`)
      const payload = await response.json() as { rows?: unknown }
      void panel.webview.postMessage({
        type: 'usageData',
        requestId,
        ok: true,
        rows: Array.isArray(payload.rows) ? payload.rows : [],
      })
    }
    catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.warn({ range, error: errMsg }, '[DASH] usage-stats fetch failed')
      void panel.webview.postMessage({ type: 'usageData', requestId, ok: false, error: errMsg })
    }
  })

  panel.onDidDispose(() => {
    dashboardPanel = null
  })
}
