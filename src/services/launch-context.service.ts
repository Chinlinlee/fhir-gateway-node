import type { JWTPayload } from "jose";

import type { LaunchContext, LaunchContextProvider } from "../types/launch-context";
import type { VerifiedJwt } from "../types/verified-jwt";
import { extractSmartFhirScopesFromTokens } from "./smart-scope.service";

/**
 * LaunchContext 的 claim 名稱；claim 名稱設定化（換 IdP）只需改動此處。
 * Single place that knows claim names; the authorization layer never reads raw claims.
 */
export const LAUNCH_CLAIM_NAMES = {
    subject: "sub",
    patient: "patient",
    patientList: "patient_list",
    scopes: "scope",
    authorizedParty: "azp",
    issuer: "iss",
    tokenId: "jti",
    subjectName: "subject_name",
    name: "name",
} as const;

/** 原樣讀取字串 claim（對齊 AuditEvent 的 agent 欄位讀法）。 */
function claimAsString(payload: JWTPayload, claim: string): string | undefined {
    const value = payload[claim];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 讀取並 trim 字串 claim；對齊原 `getJwtClaimOrFail`。 */
function claimValue(payload: JWTPayload, claim: string): string | undefined {
    const value = claimAsString(payload, claim)?.trim();
    return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * 預設 LaunchContextProvider：沿用現行 claim 名稱，行為與重構前一致。
 * Default provider preserving today's claim names and behaviour.
 */
export class DefaultLaunchContextProvider implements LaunchContextProvider {
    create(token: VerifiedJwt): LaunchContext {
        const payload = token.payload;
        const authorizedParty = claimAsString(payload, LAUNCH_CLAIM_NAMES.authorizedParty);
        const issuer = claimAsString(payload, LAUNCH_CLAIM_NAMES.issuer);
        const tokenId = claimAsString(payload, LAUNCH_CLAIM_NAMES.tokenId);
        const subject = claimAsString(payload, LAUNCH_CLAIM_NAMES.subject);
        const displayName =
            claimAsString(payload, LAUNCH_CLAIM_NAMES.subjectName) ?? claimAsString(payload, LAUNCH_CLAIM_NAMES.name);
        const scopesClaim = claimValue(payload, LAUNCH_CLAIM_NAMES.scopes);

        return {
            subject,
            patientId: claimValue(payload, LAUNCH_CLAIM_NAMES.patient),
            patientListId: claimValue(payload, LAUNCH_CLAIM_NAMES.patientList),
            scopes: extractSmartFhirScopesFromTokens(scopesClaim ? scopesClaim.split(/\s+/) : []),
            agent: {
                ...(authorizedParty !== undefined ? { authorizedParty } : {}),
                ...(issuer !== undefined ? { issuer } : {}),
                ...(tokenId !== undefined ? { tokenId } : {}),
                ...(subject !== undefined ? { subject } : {}),
                ...(displayName !== undefined ? { displayName } : {}),
            },
        };
    }
}

export const defaultLaunchContextProvider: LaunchContextProvider = new DefaultLaunchContextProvider();
