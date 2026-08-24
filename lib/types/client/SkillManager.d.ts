import { type ReactNode } from 'react';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { ManagedSkillDetail, ManagedSkillEntry } from '../protocol.ts';
export interface SkillManagerInjected {
    list: (sessionId: string) => Promise<{
        skills: readonly ManagedSkillEntry[];
    }>;
    get: (sessionId: string, name: string) => Promise<ManagedSkillDetail>;
    update: (sessionId: string, name: string, invocation: {
        modelInvocable: boolean;
        userInvocable: boolean;
    }) => Promise<ManagedSkillEntry>;
}
export type SkillManagerProps = PropsRuntime<'settings.plugins.tab'> & PropsLocale<'dsh.skillManager'> & InjectFace<SkillManagerInjected>;
export declare function SkillManager({ list, get, update, useSessions, t }: SkillManagerProps): ReactNode;
//# sourceMappingURL=SkillManager.d.ts.map