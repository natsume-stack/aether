import { expect, test } from '@jest/globals'
import type { NextApiRequest, NextApiResponse } from 'next'
import handler from '../pages/api/play-library'

test('Play library preserves player cookies and sends uncached GET/PATCH responses', async () => {
  const keys = [
    'BOX_DEPLOYMENT_MODE',
    'BOX_PLAYER_SERVICE_INTERNAL_URL',
    'PERMISSION_TOKEN_SECRET',
  ] as const
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  const originalFetch = globalThis.fetch
  try {
    process.env.BOX_DEPLOYMENT_MODE = 'play'
    process.env.BOX_PLAYER_SERVICE_INTERNAL_URL = 'http://player-service.test'
    process.env.PERMISSION_TOKEN_SECRET = 'fixture-internal'
    globalThis.fetch = async (url, options) => {
      expect(String(url)).toBe('http://player-service.test/api/player-internal/map-library')
      expect(new Headers(options.headers).get('cookie')).toBe(
        'box_local_player_device=fixture-device',
      )
      if (options.method === 'PATCH') {
        expect(JSON.parse(String(options.body))).toEqual({ mapId: 'town', favorite: true })
        return new Response(null, { status: 204 })
      }
      return Response.json(
        { entries: [], libraryEnabled: true },
        {
          headers: { 'set-cookie': 'box_local_player_device=fixture-device; Path=/; HttpOnly' },
        },
      )
    }
    for (const method of ['GET', 'PATCH']) {
      const headers = new Map<string, unknown>()
      let status = 0
      const res = {
        setHeader(name: string, value: unknown) {
          headers.set(name, value)
          return res
        },
        status(value: number) {
          status = value
          return res
        },
        send() {
          return res
        },
        end() {
          return res
        },
        json() {
          return res
        },
      }
      const req = {
        method,
        headers: { cookie: 'box_local_player_device=fixture-device' },
        socket: { remoteAddress: '127.0.0.1' },
        body: { mapId: 'town', favorite: true },
      }
      await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse)
      expect(headers.get('Cache-Control')).toBe('no-store')
      expect(status).toBe(method === 'PATCH' ? 204 : 200)
      if (method === 'GET')
        expect(headers.get('Set-Cookie')).toEqual([
          'box_local_player_device=fixture-device; Path=/; HttpOnly',
        ])
    }
  } finally {
    globalThis.fetch = originalFetch
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
  }
})
