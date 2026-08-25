import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { API } from './protocol.ts'
import { makeRoutes } from './routes.ts'

describe('loopback routes', () => {
  let directory: string
  let skillPath: string
  let server: Server
  let base: string
  let snapshotError: Error | undefined
  let snapshotSkills: SkillDefinition[]
  let resolveSkill: (name: string) => Promise<SkillDefinition | undefined>

  beforeEach(async () => {
    snapshotError = undefined
    directory = await mkdtemp(join(tmpdir(), 'dsh-skill-manager-routes-'))
    skillPath = join(directory, 'SKILL.md')
    await writeFile(skillPath, [
      '---',
      'name: example-skill',
      'description: Example',
      '---',
      '# Instructions',
      '',
    ].join('\n'))
    const skill: SkillDefinition = {
      name: 'example-skill',
      description: 'Example',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'user-dsh',
      provider: 'filesystem',
      resourceBase: { kind: 'directory', path: directory },
      path: skillPath,
      content: '# Instructions\n',
    }
    snapshotSkills = [skill]
    resolveSkill = async name => name === skill.name ? skill : undefined
    const ctx = {
      sessions: { get: (id: string) => id === 'session-1' ? { header: { cwd: directory } } : undefined },
      agents: { get: () => undefined },
      skills: {
        snapshot: async () => {
          if (snapshotError !== undefined) throw snapshotError
          return { skills: snapshotSkills, complete: true }
        },
        get: async (name: string) => await resolveSkill(name),
      },
    } as unknown as Context
    const routes = makeRoutes(ctx)
    server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname
      const route = routes.find(candidate => candidate.path === path)
      if (route === undefined) { response.writeHead(404); response.end(); return }
      void route.handler(request, response)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    base = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    await rm(directory, { recursive: true, force: true })
  })

  it('lists, lazily reads, and updates the resolved local Skill', async () => {
    const list = await fetch(`${base}${API.list}?sessionId=session-1`)
    expect(list.status).toBe(200)
    const catalog = await list.json() as { skills: Array<{ name: string; writable: boolean }> }
    expect(catalog.skills).toEqual([expect.objectContaining({ name: 'example-skill', writable: true })])

    const detail = await fetch(`${base}${API.detail}?sessionId=session-1&name=example-skill`)
    expect(detail.status).toBe(200)
    expect(await detail.json()).toEqual(expect.objectContaining({
      skill: expect.objectContaining({ content: '# Instructions\n' }),
    }))

    const update = await fetch(`${base}${API.invocation}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'session-1',
        name: 'example-skill',
        modelInvocable: false,
        userInvocable: true,
      }),
    })
    expect(update.status).toBe(200)
    const raw = await readFile(skillPath, 'utf8')
    expect(raw).toContain('disable-model-invocation: true')
    expect(raw).toContain('user-invocable: true')
  })

  it('rejects cross-site origins and unknown sessions', async () => {
    const crossSite = await fetch(`${base}${API.list}?sessionId=session-1`, {
      headers: { origin: 'https://example.com' },
    })
    expect(crossSite.status).toBe(403)
    const missing = await fetch(`${base}${API.list}?sessionId=missing`)
    expect(missing.status).toBe(404)
  })

  it('uses precise statuses for malformed request bodies', async () => {
    const wrongType = await fetch(`${base}${API.invocation}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    })
    expect(wrongType.status).toBe(415)

    const invalidJson = await fetch(`${base}${API.invocation}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    expect(invalidJson.status).toBe(400)

    const tooLarge = await fetch(`${base}${API.invocation}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(20 * 1024) }),
    })
    expect(tooLarge.status).toBe(413)
  })

  it('does not disguise unexpected provider failures as missing resources', async () => {
    snapshotError = new Error('provider credentials leaked here')
    const response = await fetch(`${base}${API.list}?sessionId=session-1`)
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'unable to list skills' })
  })

  it('bounds catalog reads while preserving snapshot order', async () => {
    snapshotSkills = Array.from({ length: 20 }, (_, index) => ({
      ...snapshotSkills[0] as SkillDefinition,
      name: `example-skill-${String(index).padStart(2, '0')}`,
    }))
    let active = 0
    let peak = 0
    resolveSkill = async name => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active -= 1
      return snapshotSkills.find(skill => skill.name === name)
    }

    const response = await fetch(`${base}${API.list}?sessionId=session-1`)
    expect(response.status).toBe(200)
    const body = await response.json() as { skills: Array<{ name: string }> }
    expect(peak).toBeLessThanOrEqual(8)
    expect(peak).toBeGreaterThan(1)
    expect(body.skills.map(skill => skill.name)).toEqual(snapshotSkills.map(skill => skill.name))
  })
})
