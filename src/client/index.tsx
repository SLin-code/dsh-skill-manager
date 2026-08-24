import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { SkillManagerApi } from './api.ts'
import { SkillManager, type SkillManagerInjected } from './SkillManager.tsx'
import { en, zh, type SkillManagerLocaleKey } from './locales.ts'

const NS = 'dsh.skillManager'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh.skillManager': SkillManagerLocaleKey
  }
}

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-skill-manager: dictionaries')
  const api = new SkillManagerApi()
  const injected = (): SkillManagerInjected => ({
    list: (sessionId) => api.list(sessionId),
    get: (sessionId, name) => api.get(sessionId, name),
    update: (sessionId, name, invocation) => api.update(sessionId, name, invocation),
  })
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'skill-manager',
    order: 5,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, SkillManager))
}

export type { SkillManagerInjected, SkillManagerProps } from './SkillManager.tsx'
