import { Buffer } from 'node:buffer'
import { expect, it } from 'vitest'
import { exportCanvasHtml } from '../handlers/canvas/canvasStore'

/**
 * 单文件 canvas 导出 — data.json 内联进 <script> 的转义。
 *
 * data.json 是用户/模型产出的内容。HTML 解析器遇到 `</script` 就结束脚本块,
 * 不管它是否位于 JS 字符串字面量内部,所以未转义时任意字符串值里的
 * `</script>` 都会截断导出文件,后半段被当作 DOM 解析。
 */

const DATA_PREFIX = 'data: new Map(Object.entries('
const DATA_SUFFIX = ')),'

function exportWith(data: unknown): string {
  return exportCanvasHtml({
    title: 'demo canvas',
    appJsGzip: new Uint8Array(),
    dataJson: new Uint8Array(Buffer.from(JSON.stringify(data), 'utf-8')),
  })
}

/** 取回内联进 <script> 的那段 JSON 文本 */
function inlinedJson(html: string): string {
  const line = html.split('\n').map(l => l.trim()).find(l => l.startsWith(DATA_PREFIX))
  expect(line).toBeDefined()
  return line!.slice(DATA_PREFIX.length, -DATA_SUFFIX.length)
}

function countScriptEnds(html: string): number {
  return html.split('</script').length - 1
}

it('round-trips ordinary canvas data unchanged', () => {
  const data = { greeting: 'hello', nested: { n: 1, list: [true, null, 'x'] } }
  const json = inlinedJson(exportWith(data))

  expect(JSON.parse(json)).toEqual(data)
})

it('does not let a </script> inside canvas data close the inline script block', () => {
  const benign = exportWith({ note: 'plain' })
  const hostile = exportWith({ note: '</script><img src=x onerror=alert(1)>' })

  // 载荷不得引入新的脚本结束标记
  expect(countScriptEnds(hostile)).toBe(countScriptEnds(benign))
  expect(hostile).not.toContain('</script><img')
})

it('preserves the escaped value semantically', () => {
  const data = { note: '</script>', comment: '<!-- not a comment -->' }
  const json = inlinedJson(exportWith(data))

  // 原文里的 `<` 全部以 \u003c 形式出现,JSON 解析后与原值完全一致
  expect(json).not.toContain('<')
  expect(JSON.parse(json)).toEqual(data)
})
