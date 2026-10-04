import { randomBytes } from "node:crypto";

import type { IssuedAuthorization, PendingAuthorization } from "../types/smart-authorization";

/** opaque handle 的位元組長度；不透明、不可推導、不含任何身分或病人資訊。 */
const HANDLE_BYTES = 32;

/**
 * gateway 在 authorization flow 裡自己記住的短期狀態：還沒回來 IdP 的 pending authorization，
 * 與已經發給 App 的一次性 code。
 *
 * 這兩張表刻意不進 launch context store：那裡放的是「哪個病人被授權給哪個使用者」的
 * 授權事實（要活到 FHIR 存取結束），這裡放的是幾秒內就該消失的流程狀態。
 *
 * 單次使用是這裡的主要性質：pending authorization 綁定成功後即刪除，code 換過一次即刪除。
 * 被 App 丟棄的流程會留下紀錄直到 gateway 重啟——這是刻意留下的簡單做法，TTL 屬於 store
 * 那一側的生命週期議題，不在本模組的職責內。
 */
export class SmartAuthorizationSessions {
    private readonly pending = new Map<string, PendingAuthorization>();
    private readonly issuedCodes = new Map<string, IssuedAuthorization>();
    private readonly issuedRefreshTokens = new Map<string, IssuedAuthorization>();

    /**
     * 記下一次轉發出去的 `authorize`。回傳 gateway 產生的 correlation id，它會被放進
     * gateway 自己的 callback `redirect_uri`，讓 callback 有辦法找回這筆狀態。
     */
    rememberAuthorization(authorization: Omit<PendingAuthorization, "correlationId">): PendingAuthorization {
        const pending: PendingAuthorization = {
            ...authorization,
            correlationId: randomBytes(HANDLE_BYTES).toString("base64url"),
        };
        this.pending.set(pending.correlationId, pending);
        return pending;
    }

    /** 依 callback 帶回的 correlation id 找出那一次 `authorize`；找不到代表這條路徑不可信。 */
    findAuthorization(correlationId: string): PendingAuthorization | undefined {
        return this.pending.get(correlationId);
    }

    /** 綁定完成後收回這次 pending authorization，讓同一條路徑無法被重走。 */
    discardAuthorization(correlationId: string): void {
        this.pending.delete(correlationId);
    }

    /**
     * 發出 gateway 自己的一次性 opaque code，並記住它對應的 IdP token。
     * 回傳的是不透明 handle，不是 JWT：gateway 不簽任何 token（ADR-0001）。
     */
    issueAuthorizationCode(issued: IssuedAuthorization): string {
        const code = randomBytes(HANDLE_BYTES).toString("base64url");
        this.issuedCodes.set(code, issued);
        this.rememberRefreshToken(issued);
        return code;
    }

    /**
     * 取出並作廢一張 code：單次使用。取不到代表這張 code 不存在或已經用過。
     *
     * 作廢發生在驗證之前——即使後面的 PKCE 檢查失敗，這張 code 也不能再拿來換 token。
     */
    consumeAuthorizationCode(code: string): IssuedAuthorization | undefined {
        const issued = this.issuedCodes.get(code);
        this.issuedCodes.delete(code);
        return issued;
    }

    /** refresh grant 用：取出這次授權目前有效的 refresh token 記錄。 */
    findRefreshToken(refreshToken: string): IssuedAuthorization | undefined {
        return this.issuedRefreshTokens.get(refreshToken);
    }

    /** IdP 換發新的 refresh token 後改用它；舊的那張一併作廢，避免記錄無限累積。 */
    rotateRefreshToken(previousRefreshToken: string, issued: IssuedAuthorization): void {
        this.issuedRefreshTokens.delete(previousRefreshToken);
        this.rememberRefreshToken(issued);
    }

    /** IdP 沒發 refresh token 的授權（沒有 `offline_access`）不會出現在 refresh 的索引裡。 */
    private rememberRefreshToken(issued: IssuedAuthorization): void {
        if (issued.refreshToken !== undefined) {
            this.issuedRefreshTokens.set(issued.refreshToken, issued);
        }
    }
}
