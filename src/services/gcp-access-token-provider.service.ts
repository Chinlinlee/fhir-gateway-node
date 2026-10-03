import { GoogleAuth } from "google-auth-library";

import { BackendCredentialError } from "../errors/backend-credential.error";
import { formatErrorMessage } from "../utils/format-error.util";

export const GCP_CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/**
 * 使用 ADC 取得 GCP access token。
 * Use Application Default Credentials to fetch GCP access token.
 */
export class GcpAccessTokenProviderService {
    private readonly auth: GoogleAuth;

    constructor() {
        this.auth = new GoogleAuth({
            scopes: [GCP_CLOUD_PLATFORM_SCOPE],
        });
    }

    /**
     * 取得 token；任何失敗都是 gateway 自己的憑證故障，因此一律轉成 `BackendCredentialError`。
     * 原始錯誤（含 `google-auth-library` 可能附帶的本機檔案路徑）只寫進 server log。
     */
    async getAccessToken(): Promise<string> {
        try {
            const client = await this.auth.getClient();
            const tokenResult = await client.getAccessToken();
            const token =
                typeof tokenResult === "string"
                    ? tokenResult
                    : typeof tokenResult === "object" && tokenResult
                      ? tokenResult.token
                      : null;
            if (!token) {
                throw new Error("Application Default Credentials returned no access token");
            }
            return token;
        } catch (error) {
            console.error(
                `[gcp-access-token] cannot obtain an ADC access token for the FHIR backend: ${formatErrorMessage(error)}`,
            );
            throw new BackendCredentialError(error);
        }
    }
}
