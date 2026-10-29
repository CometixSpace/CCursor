import type { ProviderEntry } from '../data/defaults'
import type { LLMProvider, LLMStreamEvent, LLMStreamRequest } from '../handlers/llm/types'
import { unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadProviders, setProvidersForTests } from '../config/providersStore'
import { getAgentDatabase, resetAgentDatabaseForTests } from '../database/sqlite'
import { instrumentProvider, instrumentProviderEntry } from '../usage/instrument'
import { resetUsageSettingsCacheForTests } from '../usage/settings'

class FakeProvider implements LLMProvider {
  readonly name = 'anthropic'
  constructor(private readonly events: LLMStreamEvent[]) {}
  async* stream(_request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
    for (const event of this.events)
      yield event
  }
}

describe('instrumentProvider', () => {
  it('records every done event including tool_use rounds', async () => {
    const recorded: Array<{ stopReason: string, inputTokens: number }> = []
    const provider = instrumentProvider(new FakeProvider([
      { type: 'text_delta', text: 'hi' },
      { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 2 } },
      { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 4, cacheReadTokens: 3 } },
    ]), {
      resolveContext: () => ({
        providerId: 'p1',
        providerName: 'Personal',
        providerType: 'anthropic',
        modelId: 'm1',
        apiModel: 'claude',
        displayName: 'Claude',
        pricing: {
          inputCostPerMillion: '1',
          outputCostPerMillion: '1',
          cacheReadCostPerMillion: '0.1',
          cacheCreationCostPerMillion: '0',
          costMultiplier: '1',
        },
      }),
      record: async (entry) => {
        recorded.push({ stopReason: entry.stopReason, inputTokens: entry.usage.inputTokens })
      },
    })

    const events: LLMStreamEvent[] = []
    for await (const event of provider.stream({ model: 'claude', messages: [] }))
      events.push(event)

    expect(events).toHaveLength(3)
    expect(recorded).toEqual([
      { stopReason: 'tool_use', inputTokens: 10 },
      { stopReason: 'end_turn', inputTokens: 20 },
    ])
  })

  it('still yields events if recording throws', async () => {
    const provider = instrumentProvider(new FakeProvider([
      { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
    ]), {
      resolveContext: () => ({
        providerId: 'p1',
        providerName: 'Personal',
        providerType: 'anthropic',
        modelId: 'm1',
        apiModel: 'claude',
        displayName: 'Claude',
        pricing: {
          inputCostPerMillion: '0',
          outputCostPerMillion: '0',
          cacheReadCostPerMillion: '0',
          cacheCreationCostPerMillion: '0',
          costMultiplier: '1',
        },
      }),
      record: async () => {
        throw new Error('db down')
      },
    })

    const events: LLMStreamEvent[] = []
    for await (const event of provider.stream({ model: 'claude', messages: [] }))
      events.push(event)
    expect(events).toHaveLength(1)
  })
})

describe('instrumentProviderEntry live pricing', () => {
  let tmpDbPath = ''
  let previousProviders = loadProviders()

  beforeEach(async () => {
    previousProviders = JSON.parse(JSON.stringify(loadProviders()))
    tmpDbPath = join(tmpdir(), `.tmp-usage-inst-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    process.env.BYOK_AGENT_DB_PATH = tmpDbPath
    await resetAgentDatabaseForTests()
    resetUsageSettingsCacheForTests()
  })

  afterEach(async () => {
    setProvidersForTests(previousProviders)
    await resetAgentDatabaseForTests()
    delete process.env.BYOK_AGENT_DB_PATH
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${tmpDbPath}${suffix}`)
      }
      catch {}
    }
  })

  it('prices from the live providers store instead of the cached provider snapshot', async () => {
    const staleEntry: ProviderEntry = {
      id: 'personal-glm',
      name: '个人-glm',
      type: 'anthropic',
      baseUrl: '',
      auth: { kind: 'apiKey', value: 'test-key' },
      models: [{
        id: 'flash',
        apiModel: 'z-ai/glm-5.3-flash',
        displayName: 'flash',
        thinking: false,
      }],
    }
    setProvidersForTests({
      $schemaVersion: 1,
      providers: [{
        ...staleEntry,
        models: [{
          id: 'flash',
          apiModel: 'z-ai/glm-5.3-flash',
          displayName: 'flash',
          thinking: false,
          inputCostPerMillion: '3',
          outputCostPerMillion: '15',
          cacheReadCostPerMillion: '0',
          cacheCreationCostPerMillion: '0',
          costMultiplier: '1',
        }],
      }],
    })

    const provider = instrumentProviderEntry(new FakeProvider([
      { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 1_000_000, outputTokens: 0 } },
    ]), staleEntry)

    for await (const _event of provider.stream({ model: 'z-ai/glm-5.3-flash', messages: [] })) {
      // drain
    }

    const rows = await getAgentDatabase().all<{ total_cost_micros: string, unpriced: number }>(
      'SELECT total_cost_micros, unpriced FROM usage_logs',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].unpriced).toBe(0)
    expect(rows[0].total_cost_micros).toBe('3000000')
  })
})
