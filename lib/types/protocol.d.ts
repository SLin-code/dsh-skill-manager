export declare const API: {
    readonly list: "/api/dsh-skill-manager/skills";
    readonly detail: "/api/dsh-skill-manager/skill";
    readonly invocation: "/api/dsh-skill-manager/invocation";
};
export interface ManagedSkillEntry {
    readonly name: string;
    readonly description: string;
    readonly whenToUse?: string;
    readonly modelInvocable: boolean;
    readonly userInvocable: boolean;
    readonly source: string;
    readonly provider: string;
    readonly path: string;
    readonly writable: boolean;
}
export interface ManagedSkillDetail extends ManagedSkillEntry {
    readonly content: string;
}
export interface SkillListResponse {
    readonly skills: readonly ManagedSkillEntry[];
    readonly complete: boolean;
}
export interface SkillDetailResponse {
    readonly skill: ManagedSkillDetail;
}
export interface InvocationUpdateRequest {
    readonly sessionId: string;
    readonly name: string;
    readonly modelInvocable: boolean;
    readonly userInvocable: boolean;
}
export interface InvocationUpdateResponse {
    readonly skill: ManagedSkillEntry;
}
export interface ErrorResponse {
    readonly error: string;
}
//# sourceMappingURL=protocol.d.ts.map