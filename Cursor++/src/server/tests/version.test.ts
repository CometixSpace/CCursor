import { describe, expect, it } from 'vitest'
import { compareVersions, EXTENSION_VERSION, isNewerVersion } from '../../version'

describe('extension version ownership', () => {
  it('uses the package version for server ownership metadata', () => {
    expect(EXTENSION_VERSION).toBe('0.0.16')
  })

  it('orders numeric extension versions', () => {
    expect(compareVersions('0.0.16', '0.0.15')).toBeGreaterThan(0)
    expect(compareVersions('0.1.0', '0.0.99')).toBeGreaterThan(0)
    expect(compareVersions('0.0.15', '0.0.16')).toBeLessThan(0)
    expect(compareVersions('0.0.16', '0.0.16')).toBe(0)
  })

  it('allows only a newer extension to replace the current owner', () => {
    expect(isNewerVersion('0.0.16', '0.0.15')).toBe(true)
    expect(isNewerVersion('0.0.16', '0.0.16')).toBe(false)
    expect(isNewerVersion('0.0.15', '0.0.16')).toBe(false)
  })
})
