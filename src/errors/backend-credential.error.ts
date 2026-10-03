/**
 * 對外可見的固定訊息。
 *
 * `google-auth-library` 的錯誤訊息可能帶著**本機檔案路徑**
 * （例如 `The file at C:\...\application_default_credentials.json does not exist`），
 * 因此原始錯誤一律只寫進 server log，對外只回這句不含任何內部細節的、
 * 足以讓 operator 判斷該查哪裡的訊息。
 * / Client-safe message; the raw provider error is never echoed back.
 */
export const BACKEND_CREDENTIAL_UNAVAILABLE_MESSAGE =
    "The gateway could not obtain credentials for the FHIR backend. This is a gateway-side failure, " +
    "not an authentication problem with the presented token: retry later, and check the gateway's " +
    "backend credential configuration.";

/**
 * gateway 自己的 backend 憑證無法取得（GCP ADC、metadata server 或自訂 token provider 故障）。
 *
 * 這是 gateway 端的故障，不是呼叫端的認證問題，因此對外必須是 server-side status；
 * 重新登入不可能修好它。`cause` 只留在 server 端供診斷，不可外洩。
 * / The gateway's own backend credential is unavailable — a server-side failure.
 */
export class BackendCredentialError extends Error {
    constructor(cause?: unknown) {
        super(BACKEND_CREDENTIAL_UNAVAILABLE_MESSAGE);
        this.name = "BackendCredentialError";
        if (cause !== undefined) {
            this.cause = cause;
        }
    }
}
