/**
 * Root layout — Hono JSX 生成完整 HTML, 内嵌 Alpine 指令 + webview JS
 *
 * renderHtml(webviewJs) 在 extension host 侧调用一次,
 * 产出的 HTML 字符串赋给 webview.html, 之后 Alpine.js 接管所有交互。
 */
import { Banner } from './banner'
import { Footer } from './footer'
import { Providers } from './providers'
import { WebToolsButton, WebToolsDialog } from './search-section'
import { Server } from './server'
import { styles } from './styles'
import { ToastContainer } from './toast'
import { VisionRouting } from './vision-routing'

function Layout({ webviewJs, codiconUri }: { webviewJs: string, codiconUri?: string }) {
  const codiconCss = codiconUri
    ? `@font-face { font-family: 'codicon'; font-display: block; src: url('${codiconUri}') format('truetype'); }
       .codicon { font-family: 'codicon'; font-size: 14px; line-height: 1; display: inline-block; -webkit-font-smoothing: antialiased; }
       .codicon::before { display: inline-block; }
       .codicon-eye::before { content: "\\ea70"; }
       .codicon-eye-closed::before { content: "\\eae7"; }`
    : ''

  return (
    <html>
      <head>
        <meta charset="UTF-8" />
        <style>{codiconCss + styles}</style>
      </head>
      <body x-data>
        <Banner />

        <h3>
          <span>Server</span>
          <span
            style="float:right;font-size:0.85em;font-weight:500;color:var(--vscode-descriptionForeground)"
            {...{ 'x-effect': '$el.textContent = \'v\' + ($store.app.state?.version || \'\')' }}
          >
          </span>
        </h3>
        <Server />

        <h3>Vision Routing (Image Fallback)</h3>
        <VisionRouting />

        <h3>
          <span>Providers</span>
          <span class="h3-actions">
            <WebToolsButton />
            <button class="tiny" x-on:click="$store.app.addProvider()">+ Add</button>
          </span>
        </h3>
        <Providers />

        <WebToolsDialog />

        <Footer />
        <ToastContainer />

        <script dangerouslySetInnerHTML={{ __html: webviewJs }} />
      </body>
    </html>
  )
}

/** 生成完整 HTML 字符串 (extension host 侧调用) */
/** 生成完整 HTML 字符串 (extension host 侧调用) */
export function renderHtml(webviewJs: string, codiconUri?: string): string {
  const html = (<Layout webviewJs={webviewJs} codiconUri={codiconUri} />).toString()
  return `<!DOCTYPE html>${html}`
}
