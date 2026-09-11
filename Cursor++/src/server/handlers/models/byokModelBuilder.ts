/**
 * 把 providersStore 里的 BYOK 模型转换成 Cursor AvailableModelsResponse_AvailableModel proto。
 *
 * 关键约定:
 *   - name = ProviderModel.id (不加前缀,跨 provider 重名由 providersStore first-wins)
 *   - isUserAdded = false
 *   - serverModelName = ProviderModel.id (客户端 getServerModelName 回传此值)
 *   - 有 parameters 配置时生成 parameterDefinitions + 笛卡尔积 variants (Edit 面板)
 *   - 无 parameters 时单 variant (向后兼容,无 Edit 按钮)
 */
import type { ProviderEntry, ProviderModel } from '../../data/defaults'
import type { RequestedModel_ModelParameterValue } from '../../gen/agent_v1_pb'
import type {
  AvailableModelsResponse_AvailableModel,
  ModelParameterDefinition,
} from '../../gen/aiserver_v1_pb'
import { create } from '@bufbuild/protobuf'
import { flattenModels } from '../../config/providersStore'
import { RequestedModel_ModelParameterValueSchema } from '../../gen/agent_v1_pb'
import {
  AvailableModelsResponse_AvailableModelSchema,
  AvailableModelsResponse_DegradationStatus,
  AvailableModelsResponse_ModelVariantConfigSchema,
  AvailableModelsResponse_TooltipDataSchema,
  ModelParameterDefinitionSchema,
  ModelParameterDefinition_BooleanParameterDefinitionSchema,
  ModelParameterDefinition_BooleanParameterDefinition_BooleanParameterValueSchema,
  ModelParameterDefinition_EnumParameterDefinitionSchema,
  ModelParameterDefinition_EnumParameterDefinition_EnumParameterValueSchema,
  ModelParameterDefinition_ModelParameterTypeSchema,
} from '../../gen/aiserver_v1_pb'

const VARIANT_SUFFIX_STYLE = 'color: var(--cursor-text-tertiary); font-size: 0.85em;'
const LARGE_CTX_THRESHOLD = 1_000_000

const LEVEL_LABELS: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
}

function formatBudgetLabel(budget: number): string {
  if (budget >= 1000)
    return `${Math.round(budget / 1000)}k`
  return String(budget)
}

function formatContextLabel(ctx: number): string | null {
  if (ctx < LARGE_CTX_THRESHOLD)
    return null
  if (ctx >= 1_000_000) {
    const m = Math.round(ctx / 100_000) / 10
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`
  }
  return `${Math.round(ctx / 1000)}k`
}

function formatContextDisplay(ctx: number): string {
  if (ctx >= 1_000_000) {
    const m = Math.round(ctx / 100_000) / 10
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`
  }
  return `${Math.round(ctx / 1000)}K`
}

// ── parameterDefinitions 构建 ──

function pv(id: string, value: string): RequestedModel_ModelParameterValue {
  return create(RequestedModel_ModelParameterValueSchema, { id, value })
}

function makeEnumParamDef(id: string, name: string, values: Array<{ value: string, displayName?: string }>, tooltip?: string): ModelParameterDefinition {
  return create(ModelParameterDefinitionSchema, {
    id,
    name,
    ...(tooltip ? { markdownTooltip: tooltip } : {}),
    isCycleableByHotkey: id === 'reasoning' || id === 'effort',
    parameterType: create(ModelParameterDefinition_ModelParameterTypeSchema, {
      enumParameter: create(ModelParameterDefinition_EnumParameterDefinitionSchema, {
        values: values.map(v => create(ModelParameterDefinition_EnumParameterDefinition_EnumParameterValueSchema, {
          value: v.value,
          ...(v.displayName ? { displayName: v.displayName } : {}),
        })),
      }),
    }),
  })
}

function makeBoolParamDef(id: string, name: string, tooltip?: string): ModelParameterDefinition {
  return create(ModelParameterDefinitionSchema, {
    id,
    name,
    ...(tooltip ? { markdownTooltip: tooltip } : {}),
    parameterType: create(ModelParameterDefinition_ModelParameterTypeSchema, {
      booleanParameter: create(ModelParameterDefinition_BooleanParameterDefinitionSchema, {
        values: [
          create(ModelParameterDefinition_BooleanParameterDefinition_BooleanParameterValueSchema, { value: 'true' }),
          create(ModelParameterDefinition_BooleanParameterDefinition_BooleanParameterValueSchema, { value: 'false' }),
        ],
      }),
    }),
  })
}

type ParamAxis = { id: string, values: string[] }

function buildParameterDefinitions(
  provider: ProviderEntry,
  model: ProviderModel,
): { defs: ModelParameterDefinition[], axes: ParamAxis[] } {
  const params = model.parameters
  if (!params)
    return { defs: [], axes: [] }

  const defs: ModelParameterDefinition[] = []
  const axes: ParamAxis[] = []
  const isOpenAI = provider.type === 'openai-chat' || provider.type === 'openai-responses'

  // ── Reasoning / Thinking+Effort / Budget ──
  if (params.reasoning && isOpenAI) {
    const levels: Array<{ value: string, displayName?: string }> = [
      { value: 'none', displayName: 'None' },
      ...params.reasoning.map(l => ({ value: l, displayName: LEVEL_LABELS[l] ?? l })),
    ]
    defs.push(makeEnumParamDef('reasoning', 'Reasoning', levels))
    axes.push({ id: 'reasoning', values: levels.map(v => v.value) })
  }
  else if (params.effort) {
    if (params.thinking) {
      defs.push(makeBoolParamDef('thinking', 'Thinking', 'Enable extended thinking'))
      axes.push({ id: 'thinking', values: ['false', 'true'] })
    }
    const levels = params.effort.map(l => ({ value: l, displayName: LEVEL_LABELS[l] ?? l }))
    defs.push(makeEnumParamDef('effort', 'Effort', levels))
    axes.push({ id: 'effort', values: params.effort })
  }
  else if (params.budget) {
    if (params.thinking) {
      defs.push(makeBoolParamDef('thinking', 'Thinking', 'Enable extended thinking'))
      axes.push({ id: 'thinking', values: ['false', 'true'] })
    }
    const presets = params.budget.map(b => ({
      value: String(b),
      displayName: `${formatBudgetLabel(b)} tokens`,
    }))
    defs.push(makeEnumParamDef('budget', 'Budget', presets))
    axes.push({ id: 'budget', values: params.budget.map(String) })
  }

  // ── Context ──
  if (params.context && params.context.length > 0) {
    const ctxValues = params.context.map(c => ({
      value: String(c),
      displayName: formatContextDisplay(c),
    }))
    defs.push(makeEnumParamDef('context', 'Context', ctxValues))
    axes.push({ id: 'context', values: params.context.map(String) })
  }

  // ── Fast ──
  if (params.fast) {
    defs.push(makeBoolParamDef('fast', 'Fast'))
    axes.push({ id: 'fast', values: ['false', 'true'] })
  }

  // ── Custom ──
  if (params.custom) {
    for (const c of params.custom) {
      if (c.type === 'boolean') {
        defs.push(makeBoolParamDef(c.id, c.name, c.tooltip))
        axes.push({ id: c.id, values: ['false', 'true'] })
      }
      else if (c.type === 'enum' && c.values && c.values.length > 0) {
        const enumValues = c.values.map((v, i) => ({
          value: v,
          displayName: c.displayNames?.[i],
        }))
        defs.push(makeEnumParamDef(c.id, c.name, enumValues, c.tooltip))
        axes.push({ id: c.id, values: c.values })
      }
    }
  }

  return { defs, axes }
}

// ── 笛卡尔积 variant 生成 ──

interface VariantCombo {
  params: Map<string, string>
}

function cartesianProduct(axes: ParamAxis[]): VariantCombo[] {
  if (axes.length === 0)
    return [{ params: new Map() }]
  const [first, ...rest] = axes
  const subCombos = cartesianProduct(rest)
  const result: VariantCombo[] = []
  for (const val of first.values) {
    for (const sub of subCombos) {
      const params = new Map(sub.params)
      params.set(first.id, val)
      result.push({ params })
    }
  }
  return result
}

function buildVariantSuffix(combo: VariantCombo, contextTokenLimit?: number): string | null {
  const segments: string[] = []

  const reasoning = combo.params.get('reasoning')
  const thinking = combo.params.get('thinking')
  const effort = combo.params.get('effort')
  const budget = combo.params.get('budget')
  const fast = combo.params.get('fast')
  const context = combo.params.get('context')

  // thinking segment: effort/budget 隐含 thinking 状态(无需 thinking 轴也显示);
  // thinking='false' 时不显示(用户在 Quick Switch 里关了 thinking)
  const thinkingOff = thinking === 'false'
  if (reasoning && reasoning !== 'none') {
    segments.push(`:icon-brain: ${LEVEL_LABELS[reasoning] ?? reasoning}`)
  }
  else if (effort && !thinkingOff) {
    segments.push(`:icon-brain: ${LEVEL_LABELS[effort] ?? effort}`)
  }
  else if (budget && !thinkingOff) {
    segments.push(`:icon-brain: ${formatBudgetLabel(Number(budget))}`)
  }
  else if (thinking === 'true') {
    segments.push(':icon-brain:')
  }

  if (fast === 'true')
    segments.push('Fast')

  // context: combo 有 context 轴 → 完全由选中值决定(272K 不显示, 1M 显示);
  // combo 无 context 轴 → 从 model.contextTokenLimit 兜底(≥1M 才显示)
  if (context) {
    const label = formatContextLabel(Number(context))
    if (label)
      segments.push(label)
  }
  else if (context === undefined && contextTokenLimit !== undefined) {
    const label = formatContextLabel(contextTokenLimit)
    if (label)
      segments.push(label)
  }

  return segments.length > 0 ? segments.join(' ') : null
}

function isDefaultCombo(combo: VariantCombo, model: ProviderModel): boolean {
  for (const [id, val] of combo.params) {
    switch (id) {
      case 'reasoning':
        if (model.thinking && model.thinkingLevel) {
          if (val !== model.thinkingLevel)
            return false
        }
        else if (val !== 'none')
          return false
        break
      case 'thinking':
        if (val !== String(!!model.thinking))
          return false
        break
      case 'effort':
        if (model.thinkingLevel && val !== model.thinkingLevel)
          return false
        if (!model.thinkingLevel && val !== 'medium')
          return false
        break
      case 'budget':
        if (model.thinkingBudgetTokens !== undefined && val !== String(model.thinkingBudgetTokens))
          return false
        break
      case 'context':
        if (model.contextTokenLimit !== undefined && val !== String(model.contextTokenLimit))
          return false
        break
      case 'fast':
        if (val !== String(!!model.fastMode))
          return false
        break
      default: {
        const customDef = model.parameters?.custom?.find(c => c.id === id)
        if (customDef?.default !== undefined && val !== customDef.default)
          return false
        break
      }
    }
  }
  return true
}

function comboToParamValues(combo: VariantCombo): RequestedModel_ModelParameterValue[] {
  return [...combo.params.entries()].map(([id, value]) => pv(id, value))
}

function comboToStringRepr(modelId: string, combo: VariantCombo): string {
  const parts = [...combo.params.entries()].map(([k, v]) => `${k}=${v}`)
  return `${modelId}[${parts.join(',')}]`
}

// ── 单 variant (无 parameters) 的 legacy 路径 ──

function buildLegacySuffix(model: ProviderModel): string | null {
  const segments: string[] = []
  if (model.thinking) {
    if (model.thinkingLevel) {
      const label = LEVEL_LABELS[model.thinkingLevel.toLowerCase()] ?? model.thinkingLevel
      segments.push(`:icon-brain: ${label}`)
    }
    else if (model.thinkingBudgetTokens !== undefined && model.thinkingBudgetTokens > 0)
      segments.push(`:icon-brain: ${formatBudgetLabel(model.thinkingBudgetTokens)}`)
    else
      segments.push(':icon-brain:')
  }
  if (model.fastMode)
    segments.push('Fast')
  if (model.contextTokenLimit !== undefined && model.contextTokenLimit > 0) {
    const label = formatContextLabel(model.contextTokenLimit)
    if (label)
      segments.push(label)
  }
  return segments.length > 0 ? segments.join(' ') : null
}

function buildLegacyParamValues(model: ProviderModel): RequestedModel_ModelParameterValue[] {
  const values: RequestedModel_ModelParameterValue[] = []
  if (model.thinking)
    values.push(pv('thinking', 'true'))
  // level/budget 受 thinking 门控: thinking=false 时不回传,
  // 避免 parseRunRequest 的 effort/budget 隐含规则误开 thinking
  if (model.thinking && model.thinkingLevel)
    values.push(pv('level', model.thinkingLevel))
  if (model.thinking && model.thinkingBudgetTokens !== undefined && model.thinkingBudgetTokens > 0)
    values.push(pv('budget', String(model.thinkingBudgetTokens)))
  if (model.contextTokenLimit !== undefined)
    values.push(pv('context', String(model.contextTokenLimit)))
  return values
}

function buildLegacyStringRepr(model: ProviderModel): string {
  const parts: string[] = []
  if (model.thinking)
    parts.push('thinking=true')
  if (model.thinking && model.thinkingLevel)
    parts.push(`level=${model.thinkingLevel}`)
  if (model.thinking && model.thinkingBudgetTokens !== undefined && model.thinkingBudgetTokens > 0)
    parts.push(`budget=${model.thinkingBudgetTokens}`)
  if (model.contextTokenLimit !== undefined) {
    const ctxLabel = formatContextLabel(model.contextTokenLimit)
    if (ctxLabel)
      parts.push(`context=${ctxLabel}`)
  }
  return `${model.id}[${parts.join(',')}]`
}

// ── 主构建 ──

function wrapDisplayName(base: string, suffix: string | null): string {
  if (!suffix)
    return base
  return `${base} <span style="${VARIANT_SUFFIX_STYLE}">${suffix}</span>`
}

function buildAvailableModelFromByok(
  provider: ProviderEntry,
  model: ProviderModel,
): AvailableModelsResponse_AvailableModel {
  const contextLimit = model.contextTokenLimit ?? 200000

  const tooltipData = model.tooltipMarkdown
    ? create(AvailableModelsResponse_TooltipDataSchema, { markdownContent: model.tooltipMarkdown })
    : undefined
  const tooltipDataForMaxMode = model.tooltipMarkdownForMaxMode
    ? create(AvailableModelsResponse_TooltipDataSchema, { markdownContent: model.tooltipMarkdownForMaxMode })
    : undefined

  // ── parameterDefinitions + variants ──
  const { defs, axes } = buildParameterDefinitions(provider, model)
  let variants

  if (defs.length > 0 && axes.length > 0) {
    const combos = cartesianProduct(axes)
    variants = combos.map((combo) => {
      const suffix = buildVariantSuffix(combo, model.contextTokenLimit)
      const displayName = wrapDisplayName(model.displayName, suffix)
      const isDefault = isDefaultCombo(combo, model)
      return create(AvailableModelsResponse_ModelVariantConfigSchema, {
        displayName,
        displayNameOutsidePicker: displayName,
        isDefaultMaxConfig: isDefault,
        isDefaultNonMaxConfig: isDefault && (model.defaultOn ?? false),
        variantStringRepresentation: comboToStringRepr(model.id, combo),
        parameterValues: comboToParamValues(combo),
        tooltipData,
      })
    })
  }
  else {
    const suffix = buildLegacySuffix(model)
    const displayName = wrapDisplayName(model.displayName, suffix)
    variants = [
      create(AvailableModelsResponse_ModelVariantConfigSchema, {
        displayName,
        displayNameOutsidePicker: displayName,
        isDefaultMaxConfig: true,
        isDefaultNonMaxConfig: model.defaultOn ?? false,
        variantStringRepresentation: buildLegacyStringRepr(model),
        parameterValues: buildLegacyParamValues(model),
        tooltipData,
      }),
    ]
  }

  return create(AvailableModelsResponse_AvailableModelSchema, {
    name: model.id,
    defaultOn: model.defaultOn ?? false,
    isUserAdded: false,
    supportsAgent: model.supportsAgent ?? true,
    supportsThinking: model.thinking,
    supportsImages: model.supportsImages ?? true,
    supportsCmdK: model.supportsCmdK ?? true,
    supportsAutoContext: true,
    autoContextMaxTokens: contextLimit,
    autoContextExtendedMaxTokens: contextLimit,
    supportsMaxMode: model.supportsMaxMode ?? false,
    supportsNonMaxMode: model.supportsNonMaxMode ?? true,
    contextTokenLimit: contextLimit,
    contextTokenLimitForMaxMode: contextLimit,
    supportsPlanMode: true,
    supportsSandboxing: model.supportsSandboxing ?? false,
    clientDisplayName: model.displayName,
    serverModelName: model.id,
    namedModelSectionIndex: 0,
    degradationStatus: AvailableModelsResponse_DegradationStatus.UNSPECIFIED,
    tooltipData,
    tooltipDataForMaxMode,
    parameterDefinitions: defs,
    variants,
  })
}

export function buildByokAvailableModels(): AvailableModelsResponse_AvailableModel[] {
  return flattenModels().map(({ provider, model }) => buildAvailableModelFromByok(provider, model))
}
