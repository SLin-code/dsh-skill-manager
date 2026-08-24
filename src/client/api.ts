import { API, type InvocationUpdateResponse, type ManagedSkillDetail, type ManagedSkillEntry, type SkillDetailResponse, type SkillListResponse } from '../protocol.ts'

const TIMEOUT_MS = 10_000

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, TIMEOUT_MS)
  try {
    const response = await fetch(input, { ...init, signal: controller.signal, credentials: 'same-origin' })
    const body = await response.json() as { error?: unknown } & T
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `request failed (${response.status})`)
    return body
  } finally {
    clearTimeout(timer)
  }
}

export class SkillManagerApi {
  async list(sessionId: string): Promise<{ skills: readonly ManagedSkillEntry[] }> {
    const body = await request<SkillListResponse>(`${API.list}?sessionId=${encodeURIComponent(sessionId)}`)
    return { skills: body.skills }
  }

  async get(sessionId: string, name: string): Promise<ManagedSkillDetail> {
    const query = new URLSearchParams({ sessionId, name })
    const body = await request<SkillDetailResponse>(`${API.detail}?${query.toString()}`)
    return body.skill
  }

  async update(
    sessionId: string,
    name: string,
    invocation: { modelInvocable: boolean; userInvocable: boolean },
  ): Promise<ManagedSkillEntry> {
    const body = await request<InvocationUpdateResponse>(API.invocation, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, name, ...invocation }),
    })
    return body.skill
  }
}
