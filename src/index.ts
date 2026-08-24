import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-skill'
import { makeRoutes } from './routes.ts'

export const name = 'skill-manager'
export const inject = ['webServer', 'skills', 'sessions', 'agents', 'agentPresets']

export function apply(ctx: Context): void {
  ctx.effect(() => {
    const disposers = makeRoutes(ctx).map(route => ctx.webServer.register(route))
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-skill-manager: loopback routes')
}
