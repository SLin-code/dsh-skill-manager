import { afterEach, describe, expect, it, vi } from 'vitest'
import { SkillManagerApi } from './api.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('SkillManagerApi', () => {
  it('updates by session and exact name without sending a filesystem path', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({
      skill: {
        name: 'example-skill', description: 'Example', source: 'user-dsh', provider: 'filesystem',
        path: '/host-only/SKILL.md', modelInvocable: false, userInvocable: true, writable: true,
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    const api = new SkillManagerApi()
    await api.update('session-1', 'example-skill', { modelInvocable: false, userInvocable: true })
    const init = fetch.mock.calls[0]?.[1]
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body).toEqual({
      sessionId: 'session-1',
      name: 'example-skill',
      modelInvocable: false,
      userInvocable: true,
    })
    expect(body).not.toHaveProperty('path')
  })
})
