import type { RequestListener, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeByokServer, requestByokServerTakeover } from '../../ui/state'
import { isLoopbackAddress } from '../index'

vi.mock('vscode', () => ({
  EventEmitter: class {
    event = () => ({ dispose() {} })
    fire() {}
  },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
  },
}))

let server: Server | null = null

afterEach(async () => {
  if (!server)
    return
  const current = server
  server = null
  await new Promise<void>((resolve, reject) => {
    current.close(error => error ? reject(error) : resolve())
  })
})

async function listen(handler: RequestListener): Promise<number> {
  server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', resolve)
  })
  return (server.address() as AddressInfo).port
}

describe('cursor++ server probe', () => {
  it('accepts only loopback addresses for server takeover', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('127.23.45.67')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('192.168.1.20')).toBe(false)
    expect(isLoopbackAddress('::ffff:192.168.1.20')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
  })

  it('returns the owner version from the health endpoint', async () => {
    const port = await listen((_req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true, mode: 'byok', version: '0.0.16' }))
    })

    await expect(probeByokServer('127.0.0.1', port)).resolves.toEqual({
      kind: 'byok',
      version: '0.0.16',
    })
  })

  it('recognizes a legacy owner without a version', async () => {
    const port = await listen((_req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true, mode: 'byok' }))
    })

    await expect(probeByokServer('127.0.0.1', port)).resolves.toEqual({
      kind: 'byok',
      version: undefined,
    })
  })

  it('sends the requester version when asking the owner to hand off', async () => {
    let body = ''
    const port = await listen((req, res) => {
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => body += chunk)
      req.on('end', () => {
        res.statusCode = 202
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ accepted: true }))
      })
    })

    await expect(requestByokServerTakeover('127.0.0.1', port, '0.0.16')).resolves.toBe(true)
    expect(JSON.parse(body)).toEqual({ requesterVersion: '0.0.16' })
  })
})
