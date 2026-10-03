import type { JWTPayload } from "jose";

import {
    CLAIM_NAME_FIELDS,
    type ClaimNameSettings,
    type ClaimNames,
    resolveClaimNameSettings,
    STRUCTURAL_ISSUER_CLAIM,
    STRUCTURAL_SUBJECT_CLAIM,
} from "../constants/claim-names";
import { ENV_KEYS } from "../constants/config";
import { ClaimConfigurationError } from "../errors/claim-configuration.error";
import type { LaunchContext, LaunchContextProvider } from "../types/launch-context";
import type { VerifiedJwt } from "../types/verified-jwt";
import { DefaultScopeResolver } from "./scope-resolver.service";

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

/** 列出生效的 claim 名稱，供錯誤訊息指名設定值。 */
function claimNameSettingList(claimNames: ClaimNames): string {
    return CLAIM_NAME_FIELDS.map((field) => `${field}="${claimNames[field]}"`).join(", ");
}

/**
 * 已設定 claim 名稱的「永遠不會出現」檢查（啟動時沒有 token，因此只能在此時做）。
 *
 * 情境：運維設定了 IdP 從不發出的 claim 名稱。它永遠無法命中，症狀與真正的授權拒絕完全
 * 相同——一整片無法解讀的 401。因此只有在 token **完全沒有**任何一個已設定 claim 時才
 * 視為設定錯誤；只缺其中一個（例如 patient-mode token 沒有 patient claim）維持原本的
 * 401 語意。
 *
 * Detects a configured claim name that appears in *no* token — the one failure mode
 * no request-level inspection can tell apart from a genuine authorization denial.
 */
function assertClaimNamesCanMatch(payload: JWTPayload, claimNames: ClaimNames): void {
    if (Object.values(claimNames).some((claim) => payload[claim] !== undefined)) {
        return;
    }

    throw new ClaimConfigurationError(
        `${ENV_KEYS.CLAIM_NAMES} configures claim names (${claimNameSettingList(claimNames)}) but this token ` +
            `contains none of them (claims present: ${Object.keys(payload).join(", ") || "none"}). ` +
            `Check the claim names your identity provider actually issues.`,
    );
}

/**
 * 預設 LaunchContextProvider：claim 名稱來自設定，未設定時沿用現行名稱。
 *
 * Default provider whose claim names come from configuration; an absent setting
 * preserves today's claim names and behaviour exactly.
 */
export class DefaultLaunchContextProvider implements LaunchContextProvider {
    private readonly scopeResolver: DefaultScopeResolver;

    constructor(private readonly settings: ClaimNameSettings = resolveClaimNameSettings()) {
        this.scopeResolver = new DefaultScopeResolver(this.settings.names);
    }

    create(token: VerifiedJwt): LaunchContext {
        const payload = token.payload;
        const claimNames = this.settings.names;

        // 只有運維明確設定了 claim 名稱時才啟用此檢查；未設定時行為與重構前完全一致。
        if (Object.keys(this.settings.overrides).length > 0) {
            assertClaimNamesCanMatch(payload, claimNames);
        }

        const authorizedParty = claimAsString(payload, claimNames.authorizedParty);
        const issuer = claimAsString(payload, STRUCTURAL_ISSUER_CLAIM);
        const tokenId = claimAsString(payload, claimNames.tokenId);
        const subject = claimAsString(payload, STRUCTURAL_SUBJECT_CLAIM);
        const displayName =
            claimAsString(payload, claimNames.subjectName) ?? claimAsString(payload, claimNames.name);

        return {
            subject,
            patientId: claimValue(payload, claimNames.patient),
            patientListId: claimValue(payload, claimNames.patientList),
            scopes: this.scopeResolver.resolve(payload),
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
