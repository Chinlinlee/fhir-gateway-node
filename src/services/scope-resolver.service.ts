import type { JWTPayload } from "jose";

import type { ScopeResolver } from "../types/scope-resolver";
import { extractSmartFhirScopesFromTokens, type SmartFhirScope } from "./smart-scope.service";

/**
 * SMART scopes 的 claim 名稱；兩種形式都是 OIDC/RFC 的標準 claim，與 IdP 品牌無關。
 * Scope claim names; both forms are standardised OIDC / RFC claims, not IdP conventions.
 */
export const SCOPE_CLAIM_NAMES = {
    /** OAuth 2.0 空白分隔字串（現行 Keycloak 行為）。 */
    spaceDelimited: "scope",
    /** RFC 9068 字串陣列。 */
    array: "scp",
} as const;

/** 空白分隔字串形式的 scope tokens；非字串或空字串視為未提供。 */
function readSpaceDelimitedTokens(payload: JWTPayload): string[] {
    const claim = payload[SCOPE_CLAIM_NAMES.spaceDelimited];
    if (typeof claim !== "string" || claim.trim().length === 0) {
        return [];
    }
    return claim.trim().split(/\s+/);
}

/**
 * RFC 9068 陣列形式的 scope tokens；非陣列視為未提供該形式，陣列內非字串項目直接略過。
 * 非陣列時退回 `scope` 字串形式，讓 `scp` 只影響真正以陣列交付的 IdP。
 */
function readArrayTokens(payload: JWTPayload): string[] | undefined {
    const claim = payload[SCOPE_CLAIM_NAMES.array];
    if (!Array.isArray(claim)) {
        return undefined;
    }
    return claim.filter((entry): entry is string => typeof entry === "string");
}

/**
 * 預設 ScopeResolver：兩種標準化形式都經同一套 SMART v2 文法解析，v1 `read`/`write` 的
 * `cruds` 相容處理也發生在這裡，因此 access checker 只看得到已解析的 v2 permissions。
 *
 * `scp` 為 RFC 9068 的標準形式，兩者並存時以 `scp` 為準。
 *
 * Default resolver normalising both standardised forms; `scp` wins when both are present.
 */
export class DefaultScopeResolver implements ScopeResolver {
    resolve(payload: JWTPayload): SmartFhirScope[] {
        const tokens = readArrayTokens(payload) ?? readSpaceDelimitedTokens(payload);
        return extractSmartFhirScopesFromTokens(tokens);
    }
}

export const defaultScopeResolver: ScopeResolver = new DefaultScopeResolver();
