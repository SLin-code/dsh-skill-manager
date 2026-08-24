import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import { type SkillManagerLocaleKey } from './locales.ts';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        'dsh.skillManager': SkillManagerLocaleKey;
    }
}
export declare const inject: string[];
export declare function apply(ctx: ClientContext): void;
export type { SkillManagerInjected, SkillManagerProps } from './SkillManager.tsx';
//# sourceMappingURL=index.d.ts.map