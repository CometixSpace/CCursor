import type { ProviderEntry, ProviderModel } from '../data/defaults'
import type { LLMProvider, LLMStreamEvent, LLMStreamRequest, LLMUsage } from '../handlers/llm/types'
import type { ModelPricing } from './types'
import { getProvider } from '../config/providersStore'
import { logger } from '../logger'
import { calculateUsageCost } from './calculator'
import { notifyUsageRecorded } from './events'
import { loadUsageSettings } from './settings'
import { recordUsageLog } from './store'
import { normalizeUsage, pricingFromModel } from './types'

export interface UsageRecordContext {
  providerId: string
  providerName: string
  providerType: ProviderEntry['type']
  modelId: string
  apiModel: string
  displayName: string
  pricing: ModelPricing
}

export interface InstrumentedUsageEntry {
  stopReason: string
  usage: LLMUsage
  durationMs: number
  conversationId?: string
}

export interface InstrumentHooks {
  resolveContext: (request: LLMStreamRequest) => UsageRecordContext | null
  record: (entry: InstrumentedUsageEntry & { context: UsageRecordContext }) => Promise<void>
}

export function instrumentProvider(provider: LLMProvider, hooks: InstrumentHooks): LLMProvider {
  return {
    name: provider.name,
    async* stream(request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
      const startedAt = Date.now()
      try {
        for await (const event of provider.stream(request)) {
          if (event.type === 'done') {
            const context = hooks.resolveContext(request)
            if (context) {
              try {
                await hooks.record({
                  context,
                  stopReason: event.stopReason,
                  usage: event.usage,
                  durationMs: Date.now() - startedAt,
                  conversationId: request.conversationId,
                })
              }
              catch (error) {
                logger.warn({ error: (error as Error).message }, '[USAGE] failed to record stream usage')
              }
            }
          }
          yield event
        }
      }
      catch (error) {
        const context = hooks.resolveContext(request)
        if (context) {
          try {
            await hooks.record({
              context,
              stopReason: 'error',
              usage: { inputTokens: 0, outputTokens: 0 },
              durationMs: Date.now() - startedAt,
              conversationId: request.conversationId,
            })
          }
          catch (recordError) {
            logger.warn({ error: (recordError as Error).message }, '[USAGE] failed to record error usage')
          }
        }
        throw error
      }
    },
  }
}

function findModel(models: ProviderModel[], requestModel: string): ProviderModel | undefined {
  return models.find(item => item.apiModel === requestModel)
    ?? models.find(item => item.id === requestModel)
}

export function instrumentProviderEntry(provider: LLMProvider, entry: ProviderEntry): LLMProvider {
  return instrumentProvider(provider, {
    resolveContext(request) {
      const liveEntry = getProvider(entry.id) ?? entry
      const model = findModel(liveEntry.models, request.model) ?? findModel(entry.models, request.model)
      if (!model)
        return null
      return {
        providerId: liveEntry.id,
        providerName: liveEntry.name,
        providerType: liveEntry.type,
        modelId: model.id,
        apiModel: model.apiModel,
        displayName: model.displayName || model.apiModel,
        pricing: pricingFromModel(model),
      }
    },
    async record({ context, usage, durationMs, conversationId, stopReason }) {
      const settings = loadUsageSettings()
      const normalized = normalizeUsage(usage)
      const cost = calculateUsageCost({
        providerType: context.providerType,
        usage: normalized,
        pricing: context.pricing,
      })
      await recordUsageLog({
        requestId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        providerId: context.providerId,
        providerName: context.providerName,
        providerType: context.providerType,
        modelId: context.modelId,
        apiModel: context.apiModel,
        displayName: context.displayName,
        conversationId,
        inputTokens: normalized.inputTokens,
        outputTokens: normalized.outputTokens,
        cacheReadTokens: normalized.cacheReadTokens,
        cacheWriteTokens: normalized.cacheWriteTokens,
        inputCostMicros: cost.inputMicros,
        outputCostMicros: cost.outputMicros,
        cacheReadCostMicros: cost.cacheReadMicros,
        cacheCreationCostMicros: cost.cacheCreationMicros,
        totalCostMicros: stopReason === 'error' ? 0n : cost.totalMicros,
        currency: settings.currency,
        unpriced: stopReason === 'error' ? 0 : (cost.unpriced ? 1 : 0),
        status: stopReason === 'error' ? 'error' : 'ok',
        errorMessage: stopReason === 'error' ? 'stream failed' : undefined,
        durationMs,
        createdAt: Date.now(),
      })
      notifyUsageRecorded()
    },
  })
}
