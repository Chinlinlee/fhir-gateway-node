import type { JWTPayload } from "jose";

import { type ClaimNames, DEFAULT_CLAIM_NAMES } from "../constants/claim-names";
import type { ScopeResolver } from "../types/scope-resolver";
import { extractSmartFhirScopesFromTokens, type SmartFhirScope } from "./smart-scope.service";

/** 空白分隔字串形式的 scope tokens；非字串或空字串視為未提供。 */
function readSpaceDelimitedTokens(payload: JWTPayload, claim: string): string[] {
    const value = payload[claim];
    if (typeof value !== "string" || value.trim().length === 0) {
        return [];
    }
    return value.trim().split(/\s+/);
}

/**
 * RFC 9068 陣列形式的 scope tokens；非陣列視為未提供該形式，陣列內非字串項目直接略過。
 * 非陣列時退回 `scope` 字串形式，讓 `scp` 只影響真正以陣列交付的 IdP。
 */
function readArrayTokens(payload: JWTPayload, claim: string): string[] | undefined {
    const value = payload[claim];
    if (!Array.isArray(value)) {
        return undefined;
    }
    return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * 預設 ScopeResolver：兩種標準化形式都經同一套 SMART v2 文法解析，v1 `read`/`write` 的
 * `cruds` 相容處理也發生在這裡，因此 access checker 只看得到已解析的 v2 permissions。
 *
 * 兩種形式的 claim 名稱來自 claim 名稱設定（`TOKEN_CLAIM_NAMES`），兩者並存時以
 * RFC 9068 的陣列形式為準。
 *
 * Default resolver normalising both standardised forms; the array form wins when both are present.
 */
export class DefaultScopeResolver implements ScopeResolver {
    constructor(private readonly claimNames: ClaimNames = DEFAULT_CLAIM_NAMES) {}

    resolve(payload: JWTPayload): SmartFhirScope[] {
        const tokens =
            readArrayTokens(payload, this.claimNames.scopesArray) ??
            readSpaceDelimitedTokens(payload, this.claimNames.scopesSpaceDelimited);
        return extractSmartFhirScopesFromTokens(tokens);
    }
}