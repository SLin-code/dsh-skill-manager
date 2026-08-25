import type { SkillDefinition } from '@deepseek-ai/dsh-skill';
export interface InvocationPolicy {
    readonly modelInvocable: boolean;
    readonly userInvocable: boolean;
}
export declare class SkillUpdateConflict extends Error {
    readonly name = "SkillUpdateConflict";
}
/** Update only the canonical invocation keys while preserving body text and YAML comments. */
export declare function renderInvocationPolicy(raw: string, expectedName: string, invocation: InvocationPolicy): string;
export declare function isWritableSkill(skill: SkillDefinition): Promise<boolean>;
export declare function acquireLock(path: string): Promise<() => Promise<void>>;
/** Safely mutate one already-resolved, direct disk-backed Skill definition. */
export declare function updateSkillInvocation(skill: SkillDefinition, invocation: InvocationPolicy): Promise<void>;
//# sourceMappingURL=skill-file.d.ts.map