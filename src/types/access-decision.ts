import type { FhirRequestDetails } from "./fhir-request";
import type { LaunchAgent } from "./launch-context";
import type { RequestMutation } from "./request-mutation";

/** 後端成功回應後供 postProcess 使用（Phase 7 擴充）。 */
export type FhirProxyResponse = {
    status: number;
    body: string;
};

/** Audit Event agent；對齊 Java AccessDecision.getUserWho() → Practitioner Reference。 */
export type AuditUserWho = {
    resourceType: "Practitioner";
    display?: string;
    identifier?: {
        system: string;
        value: string;
    };
};

export type AccessDecision = {
    canAccess: () => boolean;
    /**
     * postProcess 可能需要等待 backend 寫入（例如把新建立的 Patient 加回 access List），
     * 因此允許回傳 Promise；呼叫端必須 await。
     * May be asynchronous because it can write back to the backend.
     */
    getRequestMutation?: (request: FhirRequestDetails) => RequestMutation | null | undefined;
    postProcess?: (
        request: FhirRequestDetails,
        response: FhirProxyResponse,
    ) => string | null | undefined | Promise<string | null | undefined>;
    getUserWho?: (request: FhirRequestDetails) => AuditUserWho | null | undefined;
};

export function accessGranted(): AccessDecision {
    return noOpAccessDecision(true);
}

export function accessDenied(): AccessDecision {
    return noOpAccessDecision(false);
}

/** 無 mutation / postProcess；對齊 Java NoOpAccessDecision。 */
export function noOpAccessDecision(granted: boolean): AccessDecision {
    return {
        canAccess: () => granted,
        getRequestMutation: () => null,
        postProcess: () => null,
        getUserWho: () => null,
    };
}

export function accessDecisionWithMutation(
    granted: boolean,
    getMutation: (request: FhirRequestDetails) => RequestMutation | null | undefined,
): AccessDecision {
    return {
        canAccess: () => granted,
        getRequestMutation: getMutation,
        postProcess: () => null,
        getUserWho: () => null,
    };
}

/** 預設 audit user；對齊 Java AccessDecision.getUserWho() default，改讀 launch context 的 agent 欄位。 */
export function defaultUserWhoFromLaunch(agent: LaunchAgent): AuditUserWho | null {
    const subject = agent.subject ?? "";
    const issuer = agent.issuer ?? "";
    if (subject.length === 0 && issuer.length === 0) {
        return null;
    }

    const display = agent.displayName ?? "";
    const who: AuditUserWho = {
        resourceType: "Practitioner",
        ...(display.length > 0 ? { display } : {}),
    };

    if (issuer.length > 0 && subject.length > 0) {
        who.identifier = { system: issuer, value: subject };
    }

    return who;
}
