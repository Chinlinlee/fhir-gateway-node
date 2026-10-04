import type { JWTPayload } from "jose";

import type { SmartFhirScope } from "../services/smart-scope.service";

/**
 * ScopeResolver：把 IdP 交付的兩種標準化 scope 形式解析成 SMART FHIR scopes。
 *
 * 兩種形式都會走同一套 SMART v2 文法驗證，v1 `read`/`write` 到 `cruds` 的相容處理也在解析階段完成，
 * 因此 access checker 只看得到已解析的 v2 permissions。
 *
 * Normalises the two standardised scope delivery forms into resolved SMART v2 scopes;
 * access checkers never see raw scope strings.
 */
export type ScopeResolver = {
    /** 依 token claims 解析已套用相容性處理的 SMART FHIR scopes。 */
    resolve: (payload: JWTPayload) => SmartFhirScope[];
};
