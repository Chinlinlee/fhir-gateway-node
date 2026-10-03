/**
 * Claim 名稱設定與實際 token 不符。
 *
 * 這是**部署設定錯誤**，不是授權拒絕：token 通過驗簽，但一個已設定的 claim 名稱
 * 在該 token 中完全不存在，代表 gateway 與 IdP 對 claim 名稱的共識不成立。
 * 因此它對應 HTTP 500（gateway 端錯誤），並在訊息中指名 `TOKEN_CLAIM_NAMES`。
 *
 * A deployment misconfiguration — not an authorization denial — so it surfaces as
 * HTTP 500 with the offending setting named, rather than as an indistinguishable 401.
 */
export class ClaimConfigurationError extends Error {
    constructor(message: string) {
        super(message);

        this.name = "ClaimConfigurationError";
    }
}
