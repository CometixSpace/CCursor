/**
 * Usage Dashboard 前端应用 — 纯 DOM 渲染 + Chart.js 图表
 *
 * 取数传输层双宿主: webview (acquireVsCodeApi postMessage 经 extension host
 * 转发, 兼容编辑器窗口 remote 态) 与浏览器 (/byok/usage 页面, 同源 fetch
 * 直达 server)。两种环境共用聚合/图表/自动刷新逻辑。
 */
import type { ChartConfiguration } from 'chart.js'
import { Chart } from './charts'

declare function acquireVsCodeApi(): { postMessage: (msg: unknown) => void }

type UsageRange = 'today' | '7d' | '30d' | 'all'

interface UsageStatsRow {
  day: string
  hour: number
  providerId: string
  providerName: string
  modelId: string
  apiModel: string
  requestCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  lastUsedAt: number
}

interface FetchUsageMessage {
  type: 'fetchUsage'
  range: UsageRange
  requestId: number
}

interface UsageDataMessage {
  type: 'usageData'
  requestId: number
  ok: boolean
  rows?: UsageStatsRow[]
  error?: string
}

const RANGE_OPTIONS: Array<{ range: UsageRange, label: string }> = [
  { range: 'today', label: 'Today' },
  { range: '7d', label: 'Last 7 days' },
  { range: '30d', label: 'Last 30 days' },
  { range: 'all', label: 'All time' },
]

const REFRESH_INTERVAL_MS = 30_000

// ── 取数传输层 — webview / browser 双实现 ──

interface UsageTransport {
  fetchRows: (range: UsageRange) => Promise<UsageStatsRow[]>
}

/**
 * webview transport — postMessage + requestId 配对, 经 extension host 转发取数。
 * 编辑器窗口 remote 态兼容依赖该路径 (webview 内 fetch localhost 不可达),
 * 行为与传输层抽象前完全一致。
 */
function createWebviewTransport(api: { postMessage: (msg: unknown) => void }): UsageTransport {
  let requestCounter = 0
  const pendingRequests = new Map<number, {
    resolve: (rows: UsageStatsRow[]) => void
    reject: (error: Error) => void
  }>()

  window.addEventListener('message', (event: MessageEvent) => {
    const message = event.data as UsageDataMessage
    if (!message || message.type !== 'usageData')
      return
    const pending = pendingRequests.get(message.requestId)
    if (!pending)
      return
    pendingRequests.delete(message.requestId)
    if (message.ok && Array.isArray(message.rows))
      pending.resolve(message.rows)
    else
      pending.reject(new Error(message.error || 'Failed to load usage stats'))
  })

  return {
    fetchRows(range: UsageRange): Promise<UsageStatsRow[]> {
      const requestId = ++requestCounter
      return new Promise((resolve, reject) => {
        pendingRequests.set(requestId, { resolve, reject })
        const message: FetchUsageMessage = { type: 'fetchUsage', range, requestId }
        api.postMessage(message)
      })
    },
  }
}

/**
 * browser transport — 浏览器版页面由 server 本身伺服 (/byok/usage),
 * 相对路径 fetch 同源直达 /byok/usage-stats。
 */
function createBrowserTransport(): UsageTransport {
  return {
    async fetchRows(range: UsageRange): Promise<UsageStatsRow[]> {
      const response = await fetch(`/byok/usage-stats?range=${range}`)
      if (!response.ok)
        throw new Error(`HTTP ${response.status}`)
      const payload = await response.json() as { ok?: boolean, rows?: UsageStatsRow[] }
      if (!payload || payload.ok !== true || !Array.isArray(payload.rows))
        throw new Error('Malformed usage stats response')
      return payload.rows
    },
  }
}

// 启动时检测宿主: 浏览器没有 acquireVsCodeApi, 裸调用会 ReferenceError
const usageTransport: UsageTransport = typeof acquireVsCodeApi === 'function'
  ? createWebviewTransport(acquireVsCodeApi())
  : createBrowserTransport()

// ── 页面状态 ──

let currentRange: UsageRange = '7d'
let usageRows: UsageStatsRow[] = []
let loadError: string | null = null
let isLoading = false

function activeRangeLabel(): string {
  const activeOption = RANGE_OPTIONS.find(option => option.range === currentRange)
  return activeOption ? activeOption.label : currentRange
}

/**
 * 当前范围的实际日期窗口 — 让切换范围的效果可感知。
 * 数据只覆盖单日时 (功能刚上线), today 与 7d/30d/all 的聚合数字必然相同,
 * 只有这里的窗口标注能体现范围确实切换了。
 */
function describeRangeWindow(): string {
  const todayDay = toLocalDayString(new Date())
  if (currentRange === 'today')
    return todayDay
  if (currentRange === '7d')
    return `${toLocalDayString(addLocalDays(new Date(), -6))} – ${todayDay}`
  if (currentRange === '30d')
    return `${toLocalDayString(addLocalDays(new Date(), -29))} – ${todayDay}`
  const earliestDay = usageRows.length > 0 ? usageRows[0].day : null
  return earliestDay ? `${earliestDay} – ${todayDay}` : 'all time'
}

// ── 主题配色 — 从 --vscode-charts-* 变量读取, 取不到回退固定色 ──

interface ThemePalette {
  series: string[]
  foreground: string
  muted: string
  panelBorder: string
}

function resolveThemePalette(): ThemePalette {
  const styles = getComputedStyle(document.body)
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback
  return {
    series: [
      read('--vscode-charts-blue', '#3794ff'),
      read('--vscode-charts-red', '#f14c4c'),
      read('--vscode-charts-yellow', '#cca700'),
      read('--vscode-charts-green', '#89d185'),
      read('--vscode-charts-purple', '#b180d7'),
      read('--vscode-charts-orange', '#f9a55a'),
    ],
    foreground: read('--vscode-foreground', '#cccccc'),
    muted: read('--vscode-descriptionForeground', '#9d9d9d'),
    panelBorder: read('--vscode-panel-border', '#3c3c3c'),
  }
}

// ── 数字格式化 — K/M 缩写 (如 6.2M、480K) ──

function trimTrailingZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000)
    return `${trimTrailingZero((value / 1_000_000).toFixed(1))}M`
  if (value >= 1_000)
    return `${trimTrailingZero((value / 1_000).toFixed(1))}K`
  return String(value)
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`
}

// ── 本地日期工具 ──

function toLocalDayString(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function addLocalDays(date: Date, days: number): Date {
  const shifted = new Date(date)
  shifted.setDate(shifted.getDate() + days)
  return shifted
}

/** 'YYYY-MM-DD' 连续日序列 — 用 UTC 午夜解析做差, 纯日期字符串无时区歧义 */
function enumerateDayRange(startDay: string, endDay: string): string[] {
  const startMs = Date.parse(`${startDay}T00:00:00Z`)
  const endMs = Date.parse(`${endDay}T00:00:00Z`)
  const days: string[] = []
  for (let cursor = startMs; cursor <= endMs; cursor += 86_400_000) {
    const cursorDate = new Date(cursor)
    const month = String(cursorDate.getUTCMonth() + 1).padStart(2, '0')
    const day = String(cursorDate.getUTCDate()).padStart(2, '0')
    days.push(`${cursorDate.getUTCFullYear()}-${month}-${day}`)
  }
  return days
}

function dayShortLabel(day: string): string {
  return day.slice(5).replace('-', '/')
}

// ── 聚合维度: (providerId, apiModel) ──
//
// providers.json 里同一真实模型可能登记为多个 byok modelId (别名),
// 统计按 provider 实际请求的 apiModel 合并展示; 但不同 provider 的同名
// apiModel 不能合并 (官方与中转站可能挂同名模型), 所以分组键必须带
// provider 维度。providerId 稳定不可编辑做键, providerName 只做展示。

/** apiModel 为历史脏数据空串时回退 modelId, 保证分组键永不为空段 */
function effectiveApiModel(row: UsageStatsRow): string {
  return row.apiModel || row.modelId
}

function groupKeyForRow(row: UsageStatsRow): string {
  return `${row.providerId}::${effectiveApiModel(row)}`
}

/** 展示标签: "deepseek · deepseek-v4-flash" 形态 (中点两侧留空格) */
function groupLabelForRow(row: UsageStatsRow): string {
  return `${row.providerName} \u00B7 ${effectiveApiModel(row)}`
}

interface ModelAggregate {
  providerId: string
  providerName: string
  apiModel: string
  /** 展示标签 (providerName · apiModel), 建组时由 groupLabelForRow 生成 */
  label: string
  /** 汇入该组的 byok modelId (去重), 明细表悬停可见别名来源 */
  sourceModelIds: string[]
  requestCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

function rowTotalTokens(row: UsageStatsRow): number {
  return row.inputTokens + row.outputTokens
}

function aggregateByModel(rows: UsageStatsRow[]): ModelAggregate[] {
  const aggregates = new Map<string, ModelAggregate>()
  for (const row of rows) {
    const groupKey = groupKeyForRow(row)
    let aggregate = aggregates.get(groupKey)
    if (!aggregate) {
      aggregate = {
        providerId: row.providerId,
        providerName: row.providerName,
        apiModel: effectiveApiModel(row),
        label: groupLabelForRow(row),
        sourceModelIds: [],
        requestCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }
      aggregates.set(groupKey, aggregate)
    }
    if (!aggregate.sourceModelIds.includes(row.modelId))
      aggregate.sourceModelIds.push(row.modelId)
    aggregate.requestCount += row.requestCount
    aggregate.inputTokens += row.inputTokens
    aggregate.outputTokens += row.outputTokens
    aggregate.cacheReadTokens += row.cacheReadTokens
    aggregate.cacheWriteTokens += row.cacheWriteTokens
  }
  return Array.from(aggregates.values())
    .sort((left, right) =>
      (right.inputTokens + right.outputTokens) - (left.inputTokens + left.outputTokens))
}

/** 趋势图桶 — today 逐小时 (0 点到当前小时), 其他范围逐日 */
function buildTrendBuckets(range: UsageRange, rows: UsageStatsRow[]): {
  labels: string[]
  bucketIndex: (row: UsageStatsRow) => number
} {
  if (range === 'today') {
    const currentHour = new Date().getHours()
    const labels = Array.from({ length: currentHour + 1 }, (_, hour) =>
      `${String(hour).padStart(2, '0')}:00`)
    return { labels, bucketIndex: row => row.hour }
  }
  const todayDay = toLocalDayString(new Date())
  const startDay = range === '7d'
    ? toLocalDayString(addLocalDays(new Date(), -6))
    : range === '30d'
      ? toLocalDayString(addLocalDays(new Date(), -29))
      : rows.reduce((earliest, row) => (row.day < earliest ? row.day : earliest), todayDay)
  const days = enumerateDayRange(startDay, todayDay)
  const dayToIndex = new Map(days.map((day, index) => [day, index]))
  return {
    labels: days.map(dayShortLabel),
    bucketIndex: (row) => {
      const index = dayToIndex.get(row.day)
      return index === undefined ? -1 : index
    },
  }
}

// ── 图表实例管理 — 每次 render 先销毁旧实例 ──

const liveCharts: Chart[] = []

function createChart(canvas: HTMLCanvasElement, config: ChartConfiguration): Chart {
  const chart = new Chart(canvas, config)
  liveCharts.push(chart)
  return chart
}

function destroyLiveCharts(): void {
  for (const chart of liveCharts)
    chart.destroy()
  liveCharts.length = 0
}

// ── DOM 构建 ──

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  textContent?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  if (className)
    element.className = className
  if (textContent !== undefined)
    element.textContent = textContent
  return element
}

function renderToolbar(): HTMLElement {
  const toolbar = createElement('div', 'toolbar')
  const pills = createElement('div', 'pills')
  for (const option of RANGE_OPTIONS) {
    const pill = createElement('button', option.range === currentRange ? 'pill active' : 'pill', option.label)
    pill.addEventListener('click', () => void load(option.range))
    pills.appendChild(pill)
  }
  const rangeWindowCaption = createElement('span', undefined, describeRangeWindow())
  rangeWindowCaption.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground);margin-left:4px;'
  const refreshButton = createElement('button', 'refresh-btn', isLoading ? 'Refreshing…' : '⟳ Refresh')
  refreshButton.disabled = isLoading
  refreshButton.addEventListener('click', () => void load(currentRange))
  toolbar.appendChild(pills)
  toolbar.appendChild(rangeWindowCaption)
  toolbar.appendChild(refreshButton)
  return toolbar
}

function renderEmptyState(): HTMLElement {
  const container = createElement('div', 'empty-state')
  const title = createElement('div', 'title')
  const hint = createElement('div')
  if (isLoading) {
    title.textContent = 'Loading usage…'
    hint.textContent = 'Fetching stats from the BYOK server.'
  }
  else if (loadError) {
    title.textContent = 'Failed to load usage stats'
    hint.textContent = loadError
  }
  else {
    title.textContent = 'No usage recorded yet'
    hint.textContent = 'Token usage appears here after your first BYOK request.'
  }
  container.appendChild(title)
  container.appendChild(hint)
  return container
}

function renderSummaryCards(): HTMLElement {
  const totals = usageRows.reduce((accumulator, row) => ({
    totalTokens: accumulator.totalTokens + rowTotalTokens(row),
    inputTokens: accumulator.inputTokens + row.inputTokens,
    outputTokens: accumulator.outputTokens + row.outputTokens,
    cacheReadTokens: accumulator.cacheReadTokens + row.cacheReadTokens,
  }), { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 })

  const grid = createElement('div', 'summary-grid')
  const cards: Array<{ label: string, value: string }> = [
    { label: `Total Tokens (${activeRangeLabel()})`, value: formatTokenCount(totals.totalTokens) },
    { label: 'Input (incl. cache)', value: formatTokenCount(totals.inputTokens) },
    { label: 'Output', value: formatTokenCount(totals.outputTokens) },
    {
      label: 'Cache Hit Rate',
      value: totals.inputTokens > 0
        ? formatPercent(totals.cacheReadTokens / totals.inputTokens)
        : '—',
    },
  ]
  for (const card of cards) {
    const cardElement = createElement('div', 'summary-card')
    cardElement.appendChild(createElement('div', 'label', card.label))
    cardElement.appendChild(createElement('div', 'value', card.value))
    grid.appendChild(cardElement)
  }
  return grid
}

function buildTrendChartConfig(palette: ThemePalette): ChartConfiguration<'line'> {
  const { labels, bucketIndex } = buildTrendBuckets(currentRange, usageRows)
  // per-series = 一个 (providerId, apiModel) 组; 同 provider 下同一 apiModel 的
  // 多个别名并成一条线, 跨 provider 同名模型各自成线
  const perGroupSeries = new Map<string, { label: string, totals: number[] }>()
  for (const row of usageRows) {
    const index = bucketIndex(row)
    if (index < 0 || index >= labels.length)
      continue
    const groupKey = groupKeyForRow(row)
    let series = perGroupSeries.get(groupKey)
    if (!series) {
      series = {
        label: groupLabelForRow(row),
        totals: Array.from<number>({ length: labels.length }).fill(0),
      }
      perGroupSeries.set(groupKey, series)
    }
    series.totals[index] += rowTotalTokens(row)
  }
  const datasets = Array.from(perGroupSeries.values()).map((series, seriesIndex) => ({
    label: series.label,
    data: series.totals,
    borderColor: palette.series[seriesIndex % palette.series.length],
    backgroundColor: 'transparent',
    borderWidth: 2,
    pointRadius: labels.length > 40 ? 0 : 2,
    tension: 0.25,
    fill: false,
  }))
  return {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: palette.foreground, boxWidth: 12, boxHeight: 12 } },
        tooltip: { callbacks: { label: item => ` ${item.dataset.label}: ${formatTokenCount(Number(item.raw))}` } },
      },
      scales: {
        x: { ticks: { color: palette.muted, maxTicksLimit: 12 }, grid: { color: 'transparent' } },
        y: {
          ticks: { color: palette.muted, callback: value => formatTokenCount(Number(value)) },
          grid: { color: palette.panelBorder },
          beginAtZero: true,
        },
      },
    },
  }
}

function buildModelShareChartConfig(palette: ThemePalette, modelAggregates: ModelAggregate[]): ChartConfiguration<'doughnut'> {
  return {
    type: 'doughnut',
    data: {
      labels: modelAggregates.map(aggregate => aggregate.label),
      datasets: [{
        data: modelAggregates.map(aggregate => aggregate.inputTokens + aggregate.outputTokens),
        backgroundColor: modelAggregates.map((_, index) => palette.series[index % palette.series.length]),
        borderColor: 'transparent',
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '58%',
      plugins: {
        legend: { position: 'right', labels: { color: palette.foreground, boxWidth: 12, boxHeight: 12 } },
        tooltip: { callbacks: { label: item => ` ${item.label}: ${formatTokenCount(Number(item.raw))}` } },
      },
    },
  }
}

function buildHourlyRadarChartConfig(palette: ThemePalette): ChartConfiguration<'radar'> {
  const hourTotals = Array.from<number>({ length: 24 }).fill(0)
  for (const row of usageRows)
    hourTotals[row.hour] += rowTotalTokens(row)
  const labels = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0'))
  return {
    type: 'radar',
    data: {
      labels,
      datasets: [{
        label: 'Tokens by hour',
        data: hourTotals,
        borderColor: palette.series[0],
        backgroundColor: `${palette.series[0]}33`,
        pointRadius: 1.5,
        borderWidth: 2,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        r: {
          angleLines: { color: palette.panelBorder },
          grid: { color: palette.panelBorder },
          pointLabels: { color: palette.muted, font: { size: 9 } },
          ticks: {
            color: palette.muted,
            showLabelBackdrop: false,
            callback: value => formatTokenCount(Number(value)),
          },
        },
      },
    },
  }
}

function buildChartSection(titleText: string): { section: HTMLElement, canvas: HTMLCanvasElement } {
  const section = createElement('div', 'section')
  section.appendChild(createElement('div', 'section-title', titleText))
  const chartBox = createElement('div', 'chart-box')
  const canvas = createElement('canvas')
  chartBox.appendChild(canvas)
  section.appendChild(chartBox)
  return { section, canvas }
}

function renderDetailTable(modelAggregates: ModelAggregate[]): HTMLElement {
  const section = createElement('div', 'section')
  section.appendChild(createElement('div', 'section-title', 'Per-Model Details'))
  const table = createElement('table', 'usage-table')
  const headerRow = createElement('tr')
  for (const headerText of ['Provider', 'Model', 'Requests', 'Input', 'Output', 'Cache Read', 'Cache Write', 'Hit Rate'])
    headerRow.appendChild(createElement('th', undefined, headerText))
  const tableHead = createElement('thead')
  tableHead.appendChild(headerRow)
  table.appendChild(tableHead)

  const tableBody = createElement('tbody')
  for (const aggregate of modelAggregates) {
    const row = createElement('tr')
    row.appendChild(createElement('td', undefined, aggregate.providerName))
    const modelCell = createElement('td', 'model-cell', aggregate.apiModel)
    // 悬停列出汇入该组的 byok modelId 别名来源
    modelCell.title = aggregate.sourceModelIds.join('\n')
    row.appendChild(modelCell)
    row.appendChild(createElement('td', undefined, String(aggregate.requestCount)))
    row.appendChild(createElement('td', undefined, formatTokenCount(aggregate.inputTokens)))
    row.appendChild(createElement('td', undefined, formatTokenCount(aggregate.outputTokens)))
    // 缓存字段为 0 视为"无该概念/未使用" — OpenAI 无 cacheWrite、Gemini 两者皆无
    row.appendChild(createElement('td', undefined, aggregate.cacheReadTokens > 0 ? formatTokenCount(aggregate.cacheReadTokens) : '—'))
    row.appendChild(createElement('td', undefined, aggregate.cacheWriteTokens > 0 ? formatTokenCount(aggregate.cacheWriteTokens) : '—'))
    row.appendChild(createElement('td', undefined, aggregate.inputTokens > 0
      ? formatPercent(aggregate.cacheReadTokens / aggregate.inputTokens)
      : '—'))
    tableBody.appendChild(row)
  }
  table.appendChild(tableBody)
  section.appendChild(table)
  return section
}

function render(): void {
  destroyLiveCharts()
  const app = document.getElementById('app')
  if (!app)
    return
  app.textContent = ''
  app.appendChild(renderToolbar())

  if (usageRows.length === 0) {
    app.appendChild(renderEmptyState())
    return
  }

  const palette = resolveThemePalette()
  const modelAggregates = aggregateByModel(usageRows)

  app.appendChild(renderSummaryCards())

  // section 标题带当前范围 — 切范围时所有区块的作用域可感知
  const rangeLabel = activeRangeLabel()
  const trendGranularity = currentRange === 'today' ? 'hourly' : 'daily'
  const trendSection = buildChartSection(`Token Usage Trend by Model — ${rangeLabel}, ${trendGranularity}`)
  app.appendChild(trendSection.section)

  const splitContainer = createElement('div', 'chart-split')
  const shareSection = buildChartSection(`Model Share — ${rangeLabel}`)
  const radarSection = buildChartSection(`Activity by Hour (0–23) — ${rangeLabel}`)
  splitContainer.appendChild(shareSection.section)
  splitContainer.appendChild(radarSection.section)
  app.appendChild(splitContainer)

  app.appendChild(renderDetailTable(modelAggregates))

  // 图表在元素挂载后创建 (Chart.js 需要元素已在布局中拿到尺寸)
  createChart(trendSection.canvas, buildTrendChartConfig(palette))
  createChart(shareSection.canvas, buildModelShareChartConfig(palette, modelAggregates))
  createChart(radarSection.canvas, buildHourlyRadarChartConfig(palette))
}

let loadSequence = 0

async function load(range: UsageRange): Promise<void> {
  currentRange = range
  // 过期响应守卫: 快速切换范围时慢响应后到, 不能覆盖新范围的数据/加载态
  const thisLoadSequence = ++loadSequence
  isLoading = true
  render()
  try {
    const rows = await usageTransport.fetchRows(range)
    if (thisLoadSequence !== loadSequence)
      return
    usageRows = rows
    loadError = null
  }
  catch (err) {
    if (thisLoadSequence !== loadSequence)
      return
    usageRows = []
    loadError = err instanceof Error ? err.message : String(err)
  }
  finally {
    if (thisLoadSequence === loadSequence) {
      isLoading = false
      render()
    }
  }
}

export function startDashboardApp(): void {
  render()
  void load('7d')
  setInterval(() => {
    if (document.visibilityState === 'visible')
      void load(currentRange)
  }, REFRESH_INTERVAL_MS)
}
