import { GoogleAuth } from "google-auth-library";

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

    async getAccessToken(): Promise<string> {
        const client = await this.auth.getClient();
        const tokenResult = await client.getAccessToken();
        const token =
            typeof tokenResult === "string"
                ? tokenResult
                : typeof tokenResult === "object" && tokenResult
                  ? tokenResult.token
                  : null;
        if (!token) {
            throw new Error("Failed to obtain GCP access token from Application Default Credentials");
        }
        return token;
    }
}
