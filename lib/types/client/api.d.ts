import { type ManagedSkillDetail, type ManagedSkillEntry } from '../protocol.ts';
export declare class SkillManagerApi {
    list(sessionId: string): Promise<{
        skills: readonly ManagedSkillEntry[];
    }>;
    get(sessionId: string, name: string): Promise<ManagedSkillDetail>;
    update(sessionId: string, name: string, invocation: {
        modelInvocable: boolean;
        userInvocable: boolean;
    }): Promise<ManagedSkillEntry>;
}
//# sourceMappingURL=api.d.ts.map