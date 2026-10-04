import { z } from "zod";

import { OAuthError } from "../errors/oauth.error";
import { HttpUtil } from "../utils/http.util";
import { parseJson } from "../utils/parse-json.util";

/** IdP 的 token 端點回應；只取 gateway 要轉交給 App 的欄位。 */
const IdpTokenResponseSchema = z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    token_type: z.string().min(1).default("Bearer"),
    expires_in: z.number().optional(),
    scope: z.string().optional(),
});

export type IdpTokens = {
    accessToken: string;
    /** 沒有 refresh_token 的 IdP 不支援 refresh；此時 `undefined`。 */
    refreshToken?: string;
    tokenType: string;
    expiresInSeconds?: number;
    scope?: string;
};

export type IdpTokenExchangeDeps = {
    /** IdP 的 token endpoint；由啟動時快取的 discovery 文件提供。 */
    tokenEndpoint: string;
    /**
     * gateway 自己的 IdP client 憑證。gateway 不簽任何 token，這組憑證只用來證明
     * 「是 gateway 在問 IdP 要 token」，access token 的簽發權與簽章金鑰都在 IdP（ADR-0001）。
     */
    clientId: string;
    clientSecret: string;
    httpUtil?: HttpUtil;
};

/** 對 IdP 的請求時間上限；使用者正等著 302，不能讓它無限掛住。 */
const IDP_TOKEN_REQUEST_TIMEOUT_MS = 10000;

/**
 * gateway 作為 OAuth client 打 IdP 的 token endpoint：authorization_code 與 refresh_token
 * 兩種 grant。Access token 仍是 IdP 簽發的，gateway 只轉手。
 */
export class IdpTokenExchangeService {
    private readonly httpUtil: HttpUtil;

    constructor(private readonly deps: IdpTokenExchangeDeps) {
        this.httpUtil = deps.httpUtil ?? new HttpUtil();
    }

    /** 用 IdP 的 code 換 token；`code_verifier` 是 gateway 自己那一腿的 PKCE，不是 App 的。 */
    async exchangeAuthorizationCode(input: {
        code: string;
        redirectUri: string;
        codeVerifier: string;
    }): Promise<IdpTokens> {
        return this.request({
            grant_type: "authorization_code",
            code: input.code,
            redirect_uri: input.redirectUri,
            code_verifier: input.codeVerifier,
        });
    }

    async refresh(refreshToken: string): Promise<IdpTokens> {
        return this.request({ grant_type: "refresh_token", refresh_token: refreshToken });
    }

    private async request(grant: Record<string, string>): Promise<IdpTokens> {
        const response = await this.httpUtil.postForm(
            this.deps.tokenEndpoint,
            { ...grant, client_id: this.deps.clientId, client_secret: this.deps.clientSecret },
            { timeoutMs: IDP_TOKEN_REQUEST_TIMEOUT_MS },
        );

        const parsed = IdpTokenResponseSchema.safeParse(parseJson(response.body));
        if (response.status < 200 || response.status >= 300 || !parsed.success) {
            // **只記 status**：IdP 的錯誤回應 body 可能帶著 token、client id 或其他識別碼，
            // 而這份 body 會經由 `cause` 進入 `oauthErrorResponse` 的 console.error。
            // 診斷需要的是「哪一步失敗」與狀態碼，不是上游的原文。對 App 的訊息維持不變。
            throw new OAuthError("invalid_grant", "The token exchange with the identity provider failed.", {
                cause: `token endpoint returned ${response.status}`,
            });
        }

        return {
            accessToken: parsed.data.access_token,
            ...(parsed.data.refresh_token !== undefined ? { refreshToken: parsed.data.refresh_token } : {}),
            tokenType: parsed.data.token_type,
            ...(parsed.data.expires_in !== undefined ? { expiresInSeconds: parsed.data.expires_in } : {}),
            ...(parsed.data.scope !== undefined ? { scope: parsed.data.scope } : {}),
        };
    }
}
