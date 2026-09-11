/**
 * Chart.js 按需注册 — 只注册 Dashboard 用到的控制器/元素/刻度/插件,
 * 控制打包进 dist/dashboard.js 的体积 (不用 chart.js/auto 全量注册)。
 */
import {
  ArcElement,
  CategoryScale,
  Chart,
  DoughnutController,
  Filler,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  RadarController,
  RadialLinearScale,
  Tooltip,
} from 'chart.js'

Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  DoughnutController,
  ArcElement,
  RadarController,
  RadialLinearScale,
  PointElement,
  Filler,
  Legend,
  Tooltip,
)

export { Chart }
