import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { isSkillName, type SkillDefinition, type SkillRegistry, type SkillViewOptions } from '@deepseek-ai/dsh-skill'
import { API, type ErrorResponse, type InvocationUpdateRequest, type ManagedSkillEntry } from './protocol.ts'
import { isWritableSkill, updateSkillInvocation } from './skill-file.ts'

const MAX_BODY_BYTES = 16 * 1024
const MAX_SESSION_ID_LENGTH = 256

function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try { hostUrl = new URL('http://' + host) } catch { return false }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  response.end(JSON.stringify(body))
}

function fail(response: ServerResponse, status: number, message: string): void {
  json(response, status, { error: message } satisfies ErrorResponse)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw new Error('content-type must be application/json')
  }
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' ? field : undefined
}

function booleanField(value: unknown, key: string): boolean | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'boolean' ? field : undefined
}

function validateSessionId(value: string | null): string | undefined {
  if (value === null || value.length === 0 || value.length > MAX_SESSION_ID_LENGTH) return undefined
  return value
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? '/', 'http://localhost')
}

interface SkillView {
  readonly cwd: string
  readonly registry: SkillRegistry
  readonly scope: SkillViewOptions['scope']
}

function viewFor(ctx: Context, sessionId: string): SkillView {
  const session = ctx.sessions.get(sessionId as SessionId)
  if (session === undefined) throw new Error('session not found')
  if (session.header.cwd === undefined) throw new Error('session has no project directory')
  const live = ctx.agents.get(sessionId as SessionId)
  const scoped = live === undefined ? undefined : ctx.agentPresets.serviceFor(live, 'skills')
  return { cwd: session.header.cwd, registry: scoped ?? ctx.skills, scope: live }
}

async function entryOf(skill: SkillDefinition): Promise<ManagedSkillEntry | undefined> {
  if (skill.path === undefined) return undefined
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
    modelInvocable: skill.invocation.modelInvocable,
    userInvocable: skill.invocation.userInvocable,
    source: skill.source,
    provider: skill.provider,
    path: skill.path,
    writable: await isWritableSkill(skill),
  }
}

async function definitionFor(ctx: Context, sessionId: string, name: string): Promise<SkillDefinition> {
  const view = viewFor(ctx, sessionId)
  const skill = await view.registry.get(name, { cwd: view.cwd, scope: view.scope })
  if (skill === undefined || skill.path === undefined) throw new Error('skill not found')
  return skill
}

function exact(path: string, handler: WebRoute['handler']): WebRoute {
  return { kind: 'exact', path, handler }
}

export function makeRoutes(ctx: Context): WebRoute[] {
  return [
    exact(API.list, async (request, response) => {
      if (!isLoopbackRequest(request)) return fail(response, 403, 'loopback access only')
      if (request.method !== 'GET') return fail(response, 405, 'method not allowed')
      const sessionId = validateSessionId(requestUrl(request).searchParams.get('sessionId'))
      if (sessionId === undefined) return fail(response, 400, 'invalid sessionId')
      try {
        const view = viewFor(ctx, sessionId)
        const snapshot = await view.registry.snapshot({ cwd: view.cwd, scope: view.scope })
        const definitions = await Promise.all(snapshot.skills.map(skill =>
          view.registry.get(skill.name, { cwd: view.cwd, scope: view.scope })))
        const entries = await Promise.all(definitions.map(async skill => skill === undefined ? undefined : await entryOf(skill)))
        json(response, 200, { skills: entries.filter(entry => entry !== undefined), complete: snapshot.complete })
      } catch (error) {
        fail(response, 404, error instanceof Error ? error.message : 'unable to list skills')
      }
    }),
    exact(API.detail, async (request, response) => {
      if (!isLoopbackRequest(request)) return fail(response, 403, 'loopback access only')
      if (request.method !== 'GET') return fail(response, 405, 'method not allowed')
      const url = requestUrl(request)
      const sessionId = validateSessionId(url.searchParams.get('sessionId'))
      const name = url.searchParams.get('name')
      if (sessionId === undefined || name === null || !isSkillName(name)) return fail(response, 400, 'invalid request')
      try {
        const skill = await definitionFor(ctx, sessionId, name)
        const entry = await entryOf(skill)
        if (entry === undefined) return fail(response, 404, 'skill not found')
        json(response, 200, { skill: { ...entry, content: skill.content } })
      } catch (error) {
        fail(response, 404, error instanceof Error ? error.message : 'unable to read skill')
      }
    }),
    exact(API.invocation, async (request, response) => {
      if (!isLoopbackRequest(request)) return fail(response, 403, 'loopback access only')
      if (request.method !== 'POST') return fail(response, 405, 'method not allowed')
      try {
        const body = await readJson(request)
        const sessionId = validateSessionId(stringField(body, 'sessionId') ?? null)
        const name = stringField(body, 'name')
        const modelInvocable = booleanField(body, 'modelInvocable')
        const userInvocable = booleanField(body, 'userInvocable')
        if (sessionId === undefined || name === undefined || !isSkillName(name)
          || modelInvocable === undefined || userInvocable === undefined) {
          return fail(response, 400, 'invalid request')
        }
        const payload: InvocationUpdateRequest = { sessionId, name, modelInvocable, userInvocable }
        const skill = await definitionFor(ctx, payload.sessionId, payload.name)
        await updateSkillInvocation(skill, payload)
        const entry = await entryOf({ ...skill, invocation: { modelInvocable, userInvocable } })
        if (entry === undefined) return fail(response, 409, 'skill is not disk-backed')
        json(response, 200, { skill: entry })
      } catch (error) {
        fail(response, 409, error instanceof Error ? error.message : 'unable to update skill')
      }
    }),
  ]
}
