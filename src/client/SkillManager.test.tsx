// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedSkillDetail, ManagedSkillEntry } from '../protocol.ts'
import { SkillManager, type SkillManagerInjected, type SkillManagerProps } from './SkillManager.tsx'
import { en, type SkillManagerLocaleKey } from './locales.ts'

afterEach(cleanup)

const editable: ManagedSkillEntry = {
  name: 'editing-skill',
  description: 'Edit local files',
  source: 'project-agents',
  provider: 'filesystem',
  path: '/work/.agents/skills/editing-skill/SKILL.md',
  modelInvocable: true,
  userInvocable: true,
  writable: true,
}
const readonly: ManagedSkillEntry = {
  name: 'bundled-skill',
  description: 'Bundled instructions',
  source: 'bundled',
  provider: 'filesystem',
  path: '/app/skills/bundled-skill/SKILL.md',
  modelInvocable: true,
  userInvocable: true,
  writable: false,
}
const t = (key: SkillManagerLocaleKey): string => en[key]

function operations(overrides: Partial<SkillManagerInjected> = {}): SkillManagerInjected {
  return {
    list: vi.fn(async () => ({ skills: [editable, readonly] })),
    get: vi.fn(async (_sessionId, name): Promise<ManagedSkillDetail> => ({
      ...(name === editable.name ? editable : readonly),
      content: `Instructions for ${name}`,
    })),
    update: vi.fn(async (_sessionId, _name, invocation) => ({ ...editable, ...invocation })),
    ...overrides,
  }
}

function props(injected: SkillManagerInjected, current?: string): SkillManagerProps {
  return {
    ...injected,
    t,
    useSessions: ((select: (state: { current: string | undefined }) => unknown) => select({ current })) as never,
    useWorkspaces: (() => undefined) as never,
  } as SkillManagerProps
}

describe('SkillManager', () => {
  it('waits for a current session', () => {
    const api = operations()
    render(<SkillManager {...props(api)} />)
    expect(screen.getByText(en.noSession)).toBeTruthy()
    expect(api.list).not.toHaveBeenCalled()
  })

  it('filters and loads instruction detail lazily', async () => {
    const api = operations()
    render(<SkillManager {...props(api, 'session-1')} />)
    expect(await screen.findByText(editable.name)).toBeTruthy()
    expect(api.get).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('searchbox', { name: en.search }), { target: { value: 'bundled' } })
    expect(screen.queryByText(editable.name)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /bundled-skill/ }))
    expect(await screen.findByText('Instructions for bundled-skill')).toBeTruthy()
    expect(screen.getByText(en.readOnly)).toBeTruthy()
  })

  it('places invocation controls in each list row and persists changes', async () => {
    const api = operations()
    render(<SkillManager {...props(api, 'session-1')} />)
    const row = (await screen.findByText(editable.name)).closest('li')
    if (row === null) throw new Error('missing skill row')
    const automatic = within(row).getByRole('checkbox', { name: en.modelInvocation })
    fireEvent.click(automatic)
    await waitFor(() => {
      expect(api.update).toHaveBeenCalledWith('session-1', editable.name, {
        modelInvocable: false,
        userInvocable: true,
      })
    })
    expect((automatic as HTMLInputElement).checked).toBe(false)
    expect(api.get).not.toHaveBeenCalled()
  })
})
