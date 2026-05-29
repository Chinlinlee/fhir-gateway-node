import type { JWTPayload } from "jose";

import type { FhirRequestDetails } from "./fhir-request";
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
    getRequestMutation?: (request: FhirRequestDetails) => RequestMutation | null | undefined;
    postProcess?: (request: FhirRequestDetails, response: FhirProxyResponse) => string | null | undefined;
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

const CLAIM_IHE_SUBJECT_NAME = "subject_name";
const CLAIM_NAME = "name";
const CLAIM_SUBJECT = "sub";
const CLAIM_ISSUER = "iss";

function claimAsString(payload: JWTPayload, key: string): string {
    const value = payload[key];
    return typeof value === "string" ? value : "";
}

/** 預設 audit user；對齊 Java AccessDecision.getUserWho() default。 */
export function defaultUserWhoFromJwt(payload: JWTPayload): AuditUserWho | null {
    const subject = claimAsString(payload, CLAIM_SUBJECT);
    const issuer = claimAsString(payload, CLAIM_ISSUER);
    if (subject.length === 0 && issuer.length === 0) {
        return null;
    }

    let display = claimAsString(payload, CLAIM_IHE_SUBJECT_NAME);
    if (display.length === 0) {
        display = claimAsString(payload, CLAIM_NAME);
    }

    const who: AuditUserWho = {
        resourceType: "Practitioner",
        ...(display.length > 0 ? { display } : {}),
    };

    if (issuer.length > 0 && subject.length > 0) {
        who.identifier = { system: issuer, value: subject };
    }

    return who;
}
