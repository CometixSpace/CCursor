import type { ProvidersConfig } from '../data/defaults'
import { afterEach, describe, expect, it } from 'vitest'
import { setProvidersForTests } from '../config/providersStore'
import { ModelNotFoundError, resolveModel } from '../handlers/models/mapper'
import {
  isDefaultModelAlias,
  resolveDefaultModelId,
  resolveRequestedModelId,
} from '../handlers/models/requestedModelId'

const ALIAS_PROVIDERS: ProvidersConfig = {
  $schemaVersion: 1,
  providers: [{
    id: 'alias-test',
    name: 'Alias Test',
    type: 'anthropic',
    baseUrl: '',
    auth: { kind: 'apiKey', value: 'test-key' },
    models: [
      {
        id: 'non-default-model',
        apiModel: 'claude-sonnet-4',
        displayName: 'Non Default',
        thinking: false,
        defaultOn: false,
        contextTokenLimit: 200000,
      },
      {
        id: 'configured-default-model',
        apiModel: 'claude-opus-4',
        displayName: 'Configured Default',
        thinking: false,
        defaultOn: true,
        contextTokenLimit: 200000,
      },
    ],
  }],
}

function restoreSharedProviders() {
  // setup.ts 注入的是共享测试 providers; 这里恢复成它, 避免影响同进程其他测试文件
  setProvidersForTests({
    $schemaVersion: 1,
    providers: [{
      id: 'restored',
      name: 'Restored',
      type: 'anthropic',
      baseUrl: '',
      auth: { kind: 'apiKey', value: 'test-key' },
      models: [{
        id: 'claude-sonnet-4',
        apiModel: 'claude-sonnet-4',
        displayName: 'Claude Sonnet 4',
        thinking: false,
        contextTokenLimit: 200000,
      }],
    }],
  })
}

describe('default model alias', () => {
  afterEach(restoreSharedProviders)

  it('treats empty / default / auto as placeholder names', () => {
    expect(isDefaultModelAlias('')).toBe(true)
    expect(isDefaultModelAlias('default')).toBe(true)
    expect(isDefaultModelAlias('DEFAULT')).toBe(true)
    expect(isDefaultModelAlias('auto')).toBe(true)
    expect(isDefaultModelAlias(undefined)).toBe(true)
    expect(isDefaultModelAlias('model-kyn2po')).toBe(false)
  })

  it('picks the first defaultOn model instead of the first configured model', () => {
    setProvidersForTests(ALIAS_PROVIDERS)
    expect(resolveDefaultModelId()).toBe('configured-default-model')
    expect(resolveRequestedModelId('default')).toBe('configured-default-model')
  })

  it('keeps concrete model ids untouched', () => {
    setProvidersForTests(ALIAS_PROVIDERS)
    expect(resolveRequestedModelId('non-default-model')).toBe('non-default-model')
  })

  it('resolves "default" through the model mapper', () => {
    setProvidersForTests(ALIAS_PROVIDERS)
    const resolved = resolveModel('default')
    expect(resolved.apiModel).toBe('claude-opus-4')
    expect(resolved.provider).toBe('anthropic')
  })

  it('still rejects unknown concrete ids', () => {
    setProvidersForTests(ALIAS_PROVIDERS)
    expect(() => resolveModel('model-does-not-exist')).toThrow(ModelNotFoundError)
  })

  it('falls back to the original placeholder when providers.json has no models', () => {
    setProvidersForTests({ $schemaVersion: 1, providers: [] })
    expect(resolveDefaultModelId()).toBeNull()
    expect(resolveRequestedModelId('default')).toBe('default')
  })
})
