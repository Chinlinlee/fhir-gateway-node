/** OAuth 2.0 錯誤回應的 `error` 值；`server_error` 對應 gateway 或 IdP 自身的故障。 */
export type OAuthErrorCode = "invalid_request" | "invalid_grant" | "unsupported_grant_type" | "server_error";

/**
 * 授權流程裡對 App 講 OAuth 的錯誤。App 期待的是 `error`／`error_description` 的 JSON，
 * 因此這裡攜帶 OAuth 的錯誤碼，並且對外不洩漏內部細節（IdP 的錯誤留在 cause 與日誌）。
 */
export class OAuthError extends Error {
    readonly error: OAuthErrorCode;
    /** IdP 或 gateway 內部的失敗原因；只寫日誌，不對外。 */
    readonly cause?: unknown;

    constructor(error: OAuthErrorCode, message: string, options?: { cause?: unknown }) {
        super(message);
        this.name = "OAuthError";
        this.error = error;
        if (options?.cause !== undefined) {
            this.cause = options.cause;
        }
    }
}
