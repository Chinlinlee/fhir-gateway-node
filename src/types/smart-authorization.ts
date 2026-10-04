/**
 * gateway 代理 authorization flow 時自己記住的短期狀態（ADR-0002 Module 3）。
 *
 * 這些東西以前不存在：以前 gateway 完全不在 authorization flow 裡，使用者認證完成的那一刻
 * 沒有任何一方同時握有 launch id 與 `sub`。現在有——就是這兩張表。
 */

/**
 * `authorize` 轉發出去之前記下的 pending authorization。它是 callback 唯一的 correlate 來源：
 * callback 只帶 `code` 與 `state`，靠 gateway 自己塞在 `redirect_uri` 裡的 correlation id 找回這筆。
 */
export type PendingAuthorization = {
    /** gateway 產生的 opaque correlation id；只出現在 gateway 自己的 callback URL 上。 */
    correlationId: string;
    /** EHR 建立、gateway 發出的那個 launch id；綁定時要用它。 */
    launchId: string;
    /** App 的 client id：綁定的索引鍵是 `(subject, client id)`，不是 gateway 自己的 IdP client。 */
    clientId: string;
    /** App 原本的 `redirect_uri`；綁定完成後 gateway 302 回這裡。 */
    appRedirectUri: string;
    /** App 送來的 `state`；callback 要比對，並原樣帶回去。 */
    state: string;
    /** App 的 PKCE challenge；gateway 在自己的 token endpoint 驗 `code_verifier`。 */
    appCodeChallenge: string;
    /** gateway 對 IdP 那一腿自建的 PKCE verifier——App 的 verifier 不會、也不該送到 IdP。 */
    idpCodeVerifier: string;
};

/** gateway 發出的一次性 code 所對應的 IdP token；這段期間 gateway 短暫持有 IdP 的 token。 */
export type IssuedAuthorization = {
    /** IdP 簽發的 access token，gateway 原樣交給 App，不重新簽發。 */
    accessToken: string;
    /** 這張 access token 的 `jti`；launch context store 靠它把 App 帶來的 token 接回綁定。 */
    accessTokenId?: string;
    /** 綁定發生時 IdP 簽發的 `sub`；token endpoint 換發時靠它接回同一筆綁定。 */
    subject: string;
    /** IdP 簽發的 refresh token；refresh grant 以它為索引鍵。IdP 不發時沒有這個授權。 */
    refreshToken?: string;
    tokenType: string;
    scope: string;
    expiresInSeconds?: number;
    /** App 的 client id；refresh 時要核對。 */
    clientId: string;
    /** App 的 PKCE challenge；code exchange 時要驗 `code_verifier`。 */
    appCodeChallenge: string;
    /** App 原本的 `redirect_uri`；App 帶了上來就要核對（RFC 6749 §4.1.3）。 */
    appRedirectUri: string;
};
