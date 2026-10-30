import type { ProviderType, ProvidersConfig } from '../../data/defaults'
import { loadProviders } from '../../config/providersStore'
import type { LLMTool } from '../llm/types'
import type { ParsedCustomSubagent, ParsedRunRequest } from './protocol/types'

type SubagentModelOverride = ParsedRunRequest['subagentModelOverrides'][number]

const BUILTIN_SUBAGENT_TYPE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'browser-use': 'browserUse',
  'computer-use': 'computerUse',
  'general-purpose': 'generalPurpose',
  'media-review': 'mediaReview',
  'vm-setup-helper': 'vmSetupHelper',
})

export type SubagentModelEligibility =
  | { case: 'eligible' }
  | { case: 'invalid', reason: 'duplicateModelId' | 'supportsAgentFalse' | 'emptyModelId' }

export interface SubagentModelCatalogEntry {
  modelId: string
  displayName: string
  apiModel: string
  providerEntryId: string
  providerEntryName: string
  providerType: ProviderType
  eligibility: SubagentModelEligibility
}

export interface SubagentModelCatalog {
  entries: readonly SubagentModelCatalogEntry[]
  selectableEntries: readonly SubagentModelCatalogEntry[]
}

export type SubagentModelSelection =
  | { case: 'selected', source: 'explicit' | 'settings' | 'parent', entry: SubagentModelCatalogEntry }
  | { case: 'blocked', error: string }
  | { case: 'invalid', error: string }

export type PreparedSubagentTask =
  | {
    case: 'selected'
    input: Record<string, unknown>
    subagentType: string
    selection: Extract<SubagentModelSelection, { case: 'selected' }>
  }
  | Extract<SubagentModelSelection, { case: 'blocked' | 'invalid' }>

export function normalizeSubagentType(subagentType: string): string {
  return BUILTIN_SUBAGENT_TYPE_ALIASES[subagentType] ?? subagentType
}

function freezeCatalogEntry(entry: SubagentModelCatalogEntry): SubagentModelCatalogEntry {
  Object.freeze(entry.eligibility)
  return Object.freeze(entry)
}

export function createSubagentModelCatalog(config: ProvidersConfig = loadProviders()): SubagentModelCatalog {
  const modelIdCounts = new Map<string, number>()
  for (const provider of config.providers) {
    for (const model of provider.models)
      modelIdCounts.set(model.id, (modelIdCounts.get(model.id) ?? 0) + 1)
  }

  const entries = config.providers.flatMap(provider => provider.models.map((model): SubagentModelCatalogEntry => {
    let eligibility: SubagentModelEligibility = { case: 'eligible' }
    if (!model.id)
      eligibility = { case: 'invalid', reason: 'emptyModelId' }
    else if ((modelIdCounts.get(model.id) ?? 0) > 1)
      eligibility = { case: 'invalid', reason: 'duplicateModelId' }
    else if (model.supportsAgent === false)
      eligibility = { case: 'invalid', reason: 'supportsAgentFalse' }

    return freezeCatalogEntry({
      modelId: model.id,
      displayName: model.displayName,
      apiModel: model.apiModel,
      providerEntryId: provider.id,
      providerEntryName: provider.name,
      providerType: provider.type,
      eligibility,
    })
  }))
  const selectableEntries = entries.filter(entry => entry.eligibility.case === 'eligible')
  return Object.freeze({
    entries: Object.freeze(entries),
    selectableEntries: Object.freeze(selectableEntries),
  })
}

function describeInvalidCatalogEntry(entry: SubagentModelCatalogEntry): string {
  if (entry.eligibility.case === 'eligible')
    return ''
  switch (entry.eligibility.reason) {
    case 'duplicateModelId':
      return `Model "${entry.modelId}" is duplicated in providers.json and cannot be selected for a Subagent.`
    case 'supportsAgentFalse':
      return `Model "${entry.modelId}" has supportsAgent=false and cannot run a Subagent.`
    case 'emptyModelId':
      return 'A providers.json model has an empty id and cannot run a Subagent.'
  }
}

function resolveCatalogEntry(modelId: string, catalog: SubagentModelCatalog): SubagentModelSelection | SubagentModelCatalogEntry {
  const matches = catalog.entries.filter(entry => entry.modelId === modelId)
  if (matches.length === 0)
    return { case: 'invalid', error: `Model "${modelId}" is not available in the current providers.json Subagent catalog.` }
  const firstMatch = matches[0]
  if (firstMatch.eligibility.case !== 'eligible')
    return { case: 'invalid', error: describeInvalidCatalogEntry(firstMatch) }
  return firstMatch
}

export function resolveSubagentModelSelection(params: {
  subagentType: string
  explicitModelId?: string
  parentModelId: string
  overrides?: SubagentModelOverride[]
  catalog: SubagentModelCatalog
}): SubagentModelSelection {
  const canonicalSubagentType = normalizeSubagentType(params.subagentType)
  const matchingOverrides = (params.overrides ?? []).filter(
    override => normalizeSubagentType(override.subagentType) === canonicalSubagentType,
  )
  if (matchingOverrides.some(override => override.selection.case === 'disabled')) {
    return {
      case: 'blocked',
      error: `Subagent type "${canonicalSubagentType}" is disabled in Settings.`,
    }
  }
  if (!params.explicitModelId && matchingOverrides.length > 1) {
    return {
      case: 'invalid',
      error: `Subagent type "${canonicalSubagentType}" has duplicate model overrides in Settings.`,
    }
  }

  const settingsOverride = matchingOverrides[0]
  const candidate = params.explicitModelId
    ? { modelId: params.explicitModelId, source: 'explicit' as const }
    : settingsOverride?.selection.case === 'model'
      ? { modelId: settingsOverride.selection.modelId, source: 'settings' as const }
      : { modelId: params.parentModelId, source: 'parent' as const }
  const resolved = resolveCatalogEntry(candidate.modelId, params.catalog)
  if ('case' in resolved)
    return resolved
  return { case: 'selected', source: candidate.source, entry: resolved }
}

export function prepareSubagentTask(params: {
  input: Record<string, unknown>
  parentModelId: string
  overrides?: SubagentModelOverride[]
  catalog: SubagentModelCatalog
}): PreparedSubagentTask {
  const subagentType = normalizeSubagentType(String(params.input.subagent_type ?? params.input.subagentType ?? 'explore'))
  const hasModel = Object.prototype.hasOwnProperty.call(params.input, 'model')
  const hasModelId = Object.prototype.hasOwnProperty.call(params.input, 'modelId')
  if ((hasModel && typeof params.input.model !== 'string') || (hasModelId && typeof params.input.modelId !== 'string')) {
    return {
      case: 'invalid',
      error: 'Task model must be a canonical ProviderModel.id string.',
    }
  }
  const model = typeof params.input.model === 'string' ? params.input.model.trim() : ''
  const modelId = typeof params.input.modelId === 'string' ? params.input.modelId.trim() : ''
  if ((hasModel && !model) || (hasModelId && !modelId)) {
    return {
      case: 'invalid',
      error: 'Task model cannot be empty. Omit it to use Settings or inherit the parent model.',
    }
  }
  if (model && modelId && model !== modelId) {
    return {
      case: 'invalid',
      error: `Task model fields disagree: model="${model}" and modelId="${modelId}". Use one canonical ProviderModel.id.`,
    }
  }
  const explicitModelId = model || modelId || undefined
  const selection = resolveSubagentModelSelection({
    subagentType,
    explicitModelId,
    parentModelId: params.parentModelId,
    overrides: params.overrides,
    catalog: params.catalog,
  })
  if (selection.case !== 'selected')
    return selection

  const resume = typeof params.input.resume === 'string' ? params.input.resume.trim() : ''
  const isOrdinaryResume = resume.length > 0 && resume.toLowerCase() !== 'self'
  if (isOrdinaryResume && explicitModelId) {
    return {
      case: 'invalid',
      error: `Task cannot apply an explicit model while resuming existing agent "${resume}". Omit model or use resume="self" to create a new fork.`,
    }
  }

  const input = { ...params.input }
  delete input.thinking
  delete input.reasoning
  delete input.effort
  delete input.modelParameters
  delete input.subagentType
  input.subagent_type = subagentType
  input.model = selection.entry.modelId
  input.modelId = selection.entry.modelId
  return { case: 'selected', input, subagentType, selection }
}

function cloneSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>
}

function appendEnumValue(schema: Record<string, unknown>, propertyName: string, values: string[]): void {
  const properties = schema.properties
  if (!properties || typeof properties !== 'object' || Array.isArray(properties))
    return
  const property = (properties as Record<string, unknown>)[propertyName]
  if (!property || typeof property !== 'object' || Array.isArray(property))
    return
  const descriptor = property as Record<string, unknown>
  const existing = Array.isArray(descriptor.enum)
    ? descriptor.enum.filter((value): value is string => typeof value === 'string')
    : []
  descriptor.enum = [...new Set([...existing, ...values])]
}

function configureModelSchema(schema: Record<string, unknown>, catalog: SubagentModelCatalog): void {
  const properties = schema.properties
  if (!properties || typeof properties !== 'object' || Array.isArray(properties))
    return
  const descriptors = properties as Record<string, unknown>
  delete descriptors.attachments
  const model = descriptors.model
  if (!model || typeof model !== 'object' || Array.isArray(model))
    return
  const descriptor = model as Record<string, unknown>
  descriptor.enum = catalog.selectableEntries.map(entry => entry.modelId)
  const details = catalog.selectableEntries.map(entry =>
    `- ${entry.modelId}: ${entry.displayName}; API model ${entry.apiModel}; provider ${entry.providerEntryName} (${entry.providerType}, ${entry.providerEntryId}).`,
  )
  descriptor.description = [
    'Optional canonical ProviderModel.id for this Subagent. If omitted, Settings may override it; otherwise the parent model is inherited.',
    ...details,
  ].join('\n')
}

function removeStaticModelCatalog(description: string): string {
  return description
    .replace(/\n\nAvailable models:[\s\S]*?(?=\n\nWhen speaking to the USER|$)/, '')
    .replace(/\n\nWhen speaking to the USER[\s\S]*$/, '')
    .trimEnd()
}

/**
 * Task/Subagent 的 schema 是 provider-specific 静态定义；客户端自定义 Subagent
 * 来自 RequestContext blob。这里按轮生成副本，把名称加入 enum/description，既不
 * 污染全局 registry，也让 cursor namespace discovery 返回完整的当前轮 schema。
 */
export function contextualizeSubagentTools(
  tools: LLMTool[],
  customSubagents: ParsedCustomSubagent[],
  modelCatalog: SubagentModelCatalog = createSubagentModelCatalog(),
): LLMTool[] {
  const available = customSubagents
    .filter(subagent => subagent.name.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name))
  const names = available.map(subagent => subagent.name)
  const catalog = available.map(subagent => {
    const mode = subagent.permissionMode === 'readonly' ? ' (read-only)' : ''
    return `- ${subagent.name}${mode}: ${subagent.description || 'Custom subagent.'}`
  }).join('\n')

  return tools.flatMap((tool) => {
    if (tool.name !== 'Task' && tool.name !== 'Subagent')
      return [tool]
    if (modelCatalog.selectableEntries.length === 0)
      return []
    const inputSchema = cloneSchema(tool.inputSchema)
    appendEnumValue(inputSchema, 'subagent_type', names)
    appendEnumValue(inputSchema, 'subagentType', names)
    configureModelSchema(inputSchema, modelCatalog)
    const modelCatalogDescription = `\n\nAvailable models use canonical ProviderModel.id values:\n${modelCatalog.selectableEntries.map(entry =>
      `- ${entry.modelId}: ${entry.displayName} (API model ${entry.apiModel}; ${entry.providerEntryName}, ${entry.providerType}).`,
    ).join('\n')}`
    const customCatalogDescription = available.length > 0
      ? `\n\nAdditional workspace subagent_types:\n${catalog}`
      : ''
    return [{
      ...tool,
      description: `${removeStaticModelCatalog(tool.description)}${modelCatalogDescription}${customCatalogDescription}`,
      inputSchema,
    }]
  })
}
