/**
 * Cursor++ 侧边栏面板 — Server 控制 + Provider 配置
 *
 * 渲染策略:
 *   - Hono JSX 生成带 Alpine 指令的静态 HTML (extension host 侧, 一次性)
 *   - dist/webview.js (Alpine.js + store) 内联注入, 接管所有交互
 *   - 通过 postMessage 与 extension host 双向通信
 *
 * Provider 机制:
 *   - 数据源: ~/.ccursor/providers.json (通过 providersStore)
 *   - Alpine store 管理 drafts / expanded / autocomplete 等 UI 状态
 *   - 所有表单交互由 Alpine 响应式处理, 无 innerHTML 重写
 */
import type { ProviderEntry } from '../server/data/defaults'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as vscode from 'vscode'
import { bumpRefreshSignal } from '../server'
import { searchCatalog } from '../server/config/catalogStore'
import { lookupModel, updateProviders } from '../server/config/providersStore'
import { resetProviderInstanceCache } from '../server/handlers/llm/providerRuntime'
import { renderHtml } from './components/layout'
import { getState, onStateChange, refreshState } from './state'

let webviewJsCache: string | null = null
const RE_TRAILING_SLASH = /\/+$/

function getWebviewJs(extensionPath: string): string {
  if (!webviewJsCache) {
    const raw = readFileSync(join(extensionPath, 'dist', 'webview.js'), 'utf-8')
    // 内联 <script> 安全转义: </script> 和 <!-- 会被 HTML 解析器截断
    webviewJsCache = raw.replaceAll('</script>', '<\\/script>').replaceAll('<!--', '<\\!--')
  }
  return webviewJsCache
}

export class PanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'cursor2plus.panel'

  private view?: vscode.WebviewView
  private context: vscode.ExtensionContext
  private disposeStateListener?: vscode.Disposable

  constructor(context: vscode.ExtensionContext) {
    this.context = context
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView
    webviewView.webview.options = { enableScripts: true }

    const webviewJs = getWebviewJs(this.context.extensionPath)

    // codicon 字体 — 引用 Cursor.app 内置的 codicon.ttf
    const cursorAppPath = vscode.Uri.file(join(this.context.extensionPath, '..', '..', 'out', 'media', 'codicon.ttf'))
    const codiconUri = webviewView.webview.asWebviewUri(cursorAppPath).toString()

    webviewView.webview.html = renderHtml(webviewJs, codiconUri)

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          await refreshState()
          this.postState()
          break
        case 'toggleByok':
          await vscode.commands.executeCommand('cursor2plus.toggleByok')
          break
        case 'toggleServer':
          await vscode.commands.executeCommand('cursor2plus.serverToggle')
          break
        case 'editRoutes':
          await vscode.commands.executeCommand('cursor2plus.editRoutes')
          break
        case 'editProvidersJson':
          await vscode.commands.executeCommand('cursor2plus.editProviders')
          break
        case 'toggleFileLog':
          await vscode.commands.executeCommand('cursor2plus.toggleFileLog')
          break
        case 'openLogFile':
          await vscode.commands.executeCommand('cursor2plus.openLogFile')
          break
        case 'searchCatalog': {
          const query = typeof msg.query === 'string' ? msg.query : ''
          const results = searchCatalog(query, 30)
          this.view?.webview.postMessage({
            type: 'catalogResults',
            requestId: msg.requestId,
            results,
          })
          break
        }
        case 'fetchRemoteModels': {
          const pid = msg.pid as string
          console.log('[FETCH_MODELS] received', pid)
          const providers = getState().providers || []
          const draft = msg.draft as any
          const p = draft || providers.find((x: any) => x.id === pid)
          if (!p?.auth?.value) {
            this.view?.webview.postMessage({ type: 'remoteModelsResult', pid, error: 'Auth value not set' })
            break
          }
          const baseUrl = (p.baseUrl || '').trim()
          if (!baseUrl) {
            this.view?.webview.postMessage({ type: 'remoteModelsResult', pid, error: 'Base URL not set' })
            break
          }
          const base = baseUrl.replace(RE_TRAILING_SLASH, '')
          const url = p.type === 'anthropic'
            ? `${base}/v1/models`
            : p.type === 'gemini'
              // Gemini Developer API: GET {host}/v1beta/models (key 走 x-goog-api-key header)
              ? `${base}/v1beta/models`
              : `${base}/models`
          try {
            const headers: Record<string, string> = {}
            if (p.type === 'gemini') {
              headers['x-goog-api-key'] = p.auth.value
              headers['x-goog-api-client'] = 'google-genai-sdk/2.7.0'
            }
            else {
              headers.Authorization = `Bearer ${p.auth.value}`
              if (p.type === 'anthropic') {
                headers['x-api-key'] = p.auth.value
                headers['anthropic-version'] = '2023-06-01'
              }
            }
            if (p.headers && typeof p.headers === 'object') {
              for (const [k, v] of Object.entries(p.headers)) {
                if (typeof v === 'string')
                  headers[k] = v
              }
            }
            const resp = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
            if (!resp.ok) {
              const body = await resp.text().catch(() => '')
              this.view?.webview.postMessage({ type: 'remoteModelsResult', pid, error: `${resp.status} ${resp.statusText}: ${body.slice(0, 200)}` })
              break
            }
            const json = await resp.json() as any
            const raw = json.data || json.models || []
            const models = raw.map((m: any) => ({
              // OpenAI: m.id; Anthropic: m.id; Gemini: m.name (e.g. "models/gemini-2.5-flash")
              id: m.id || m.name || m.model || '',
              created: m.created || 0,
              ownedBy: m.owned_by || '',
              displayName: m.displayName || '',
            })).filter((m: any) => m.id)
            models.sort((a: any, b: any) => (b.created || 0) - (a.created || 0))
            this.view?.webview.postMessage({ type: 'remoteModelsResult', pid, models })
          }
          catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            this.view?.webview.postMessage({ type: 'remoteModelsResult', pid, error: errMsg })
          }
          break
        }
        case 'saveWebTools': {
          try {
            const { updateWebTools } = await import('../server/config/searchConfigStore')
            await updateWebTools((draft) => {
              Object.assign(draft, msg.config)
            })
            await refreshState()
            this.postState()
          }
          catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            this.view?.webview.postMessage({ type: 'toast', text: `Save search config failed: ${errMsg}`, level: 'error', duration: 6000 })
          }
          break
        }
        case 'saveVisionModel': {
          const visionModelId = typeof msg.modelId === 'string' ? msg.modelId.trim() : ''
          try {
            if (visionModelId) {
              const resolved = lookupModel(visionModelId)
              if (!resolved)
                throw new Error(`Model "${visionModelId}" is not registered`)
              if (resolved.model.supportsImages === false)
                throw new Error(`Model "${visionModelId}" does not support images`)
              if (resolved.model.supportsAgent === false)
                throw new Error(`Model "${visionModelId}" does not support Agent mode`)
            }
            await updateProviders((draft) => {
              draft.visionModelId = visionModelId
            })
            const state = await refreshState()
            this.postState()
            this.view?.webview.postMessage({
              type: 'visionModelSaved',
              state,
              text: visionModelId ? 'Vision model saved.' : 'Vision routing disabled.',
            })
          }
          catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            this.view?.webview.postMessage({ type: 'visionModelSaveFailed', error: errMsg })
          }
          break
        }
        case 'saveProviders': {
          const next = msg.providers as ProviderEntry[]
          const requestId = typeof msg.requestId === 'string' ? msg.requestId : undefined
          const targetIds = Array.isArray(msg.targetIds) ? msg.targetIds : undefined
          try {
            await updateProviders((draft) => {
              draft.providers = next
            })
            resetProviderInstanceCache()
            bumpRefreshSignal()
            const state = await refreshState()
            this.postState()
            if (requestId) {
              this.view?.webview.postMessage({
                type: 'saveProvidersResult',
                requestId,
                targetIds,
                ok: true,
                state,
              })
            }
            else {
              this.view?.webview.postMessage({ type: 'toast', text: 'Providers saved.', level: 'info' })
            }
          }
          catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            if (requestId) {
              this.view?.webview.postMessage({
                type: 'saveProvidersResult',
                requestId,
                targetIds,
                ok: false,
                error: errMsg,
              })
            }
            else {
              this.view?.webview.postMessage({ type: 'toast', text: `Save failed: ${errMsg}`, level: 'error', duration: 6000 })
            }
          }
          break
        }
      }
    })

    this.disposeStateListener?.dispose()
    this.disposeStateListener = onStateChange(() => this.postState())
    webviewView.onDidDispose(() => {
      this.disposeStateListener?.dispose()
      this.disposeStateListener = undefined
      this.view = undefined
    })
  }

  private postState() {
    if (!this.view)
      return
    const s = getState()
    this.view.webview.postMessage({ type: 'state', state: s })
  }
}
