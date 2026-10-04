/**
 * Audience policy：gateway 接受哪些 `aud` 值的單一決策點，與 issuer policy 同屬驗證階段的策略層。
 *
 * RFC 9068 §4 / RFC 8725 §3.9 / RFC 9700 §2.3 要求資源伺服器拒絕 `aud` 不含自己的 token；
 * SMART App Launch 2.2 則要求 `aud` 匹配 RS 自己的 FHIR endpoint。這是縱深防禦——tenant 邊界
 * 的主防線仍是 issuer 比對（見 ADR-0003）。
 *
 * 未設定或空白 `TOKEN_AUDIENCE` 時回傳 `undefined`：jwtVerify 因此完全不做 `aud` 校驗，
 * 既有部署升級後行為完全不變。實際比對交給 jwtVerify 的 `audience` 選項，它以集合語意處理
 * （token 多個 `aud` 任一命中即接受，單一字串與陣列皆可），失敗訊息只描述失敗類別。
 *
 * Single decision point for the opt-in `aud` check.
 *
 * @param tokenAudience `TOKEN_AUDIENCE` 解析後的值；未設定或無有效值時為 undefined
 * @returns 傳給 jwtVerify 的 `audience` 選項；undefined 代表不校驗
 */
export function resolveExpectedAudiences(tokenAudience: readonly string[] | undefined): string[] | undefined {
    return tokenAudience && tokenAudience.length > 0 ? [...tokenAudience] : undefined;
}
