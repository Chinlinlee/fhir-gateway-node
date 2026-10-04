import { SMART_API_PREFIX, SMART_CALLBACK_PATH } from "../../constants/routes";
import { OAuthError } from "../../errors/oauth.error";
import { IdpTokenExchangeService } from "../../services/idp-token-exchange.service";
import type { SmartAuthorizationSessions } from "../../services/smart-authorization-sessions.service";
import type { TokenVerifierService } from "../../services/token-verifier.service";
import type { LaunchContextStore } from "../../types/launch-context-store";
import type { IssuedAuthorization, PendingAuthorization } from "../../types/smart-authorization";
import { constantTimeEquals } from "../../utils/constant-time.util";
import { createPkcePair, matchesS256Challenge, PKCE_CHALLENGE_METHOD_S256 } from "../../utils/pkce.util";
import { smartEndpointUrl } from "../../utils/smart-endpoint.util";
import type { OidcDiscovery } from "../../validations/oidc-discovery.schema";
import { OidcDiscoverySchema } from "../../validations/oidc-discovery.schema";

/** gateway 代理 authorization flow 需要的依賴；由 route 在 app 建構時解析好傳進來。 */
export type SmartAuthorizationDeps = {
    /**
     * operator 設定的 gateway public base URL。端點改寫一律用它，絕不從請求的 `Host`
     * 推導——那個 header 由呼叫端控制。
     */
    publicBaseUrl: string;
    /** gateway 自己的 IdP client 憑證；只證明「是 gateway 在問 IdP 要 token」（ADR-0001）。 */
    idpClientId: string;
    idpClientSecret: string;
    store: LaunchContextStore;
    sessions: SmartAuthorizationSessions;
    /** 驗證 IdP 發的 access token：callback 要從裡面取出 `sub` 才能綁定。 */
    tokenVerifier: TokenVerifierService;
};

/**
 * `authorize` 轉發到 IdP 時原樣帶過去的參數。`redirect_uri` 不在清單裡——它必須被改寫成
 * gateway 自己的 callback，不改寫就不成立：callback 不經過 gateway，綁定不可能發生。
 */
const PASSTHROUGH_AUTHORIZATION_PARAMS = ["scope", "aud", "nonce", "launch", "resource"] as const;

/** OAuth 的 token 端點回應不得被任何中介快取（RFC 6749 §5.1）。 */
const NO_STORE_HEADERS = { "cache-control": "no-store", pragma: "no-cache" } as const;

export abstract class SmartAuthorizationController {
    /**
     * App 的 `authorize` 請求進來：先確認 launch id 還沒被用過，再轉發給 IdP。
     *
     * 轉發前擋掉未知或已綁定的 launch id，是為了讓 IdP 完全不知道這次 launch 的存在——
     * 放行到最後只會讓 IdP 對著一個它不認識的 launch 完成認證，然後在使用者面前失敗。
     */
    static async authorize(request: Request, deps: SmartAuthorizationDeps): Promise<Response> {
        const params = new URL(request.url).searchParams;
        const clientId = requireParam(params, "client_id");
        const appRedirectUri = requireParam(params, "redirect_uri");
        const launchId = requireParam(params, "launch");
        const appCodeChallenge = requireParam(params, "code_challenge");
        // 只接受 S256：`plain` 等於沒有 PKCE。
        if (params.get("code_challenge_method") !== PKCE_CHALLENGE_METHOD_S256) {
            throw new OAuthError("invalid_request", "Only the S256 code challenge method is supported.");
        }

        if (!(await deps.store.isAvailable(launchId))) {
            throw new OAuthError("invalid_request", "The launch is unknown, has expired, or has already been used.");
        }

        // App 的 PKCE 由 gateway 驗證，所以 App 的 `code_verifier` 不會、也不該送到 IdP；
        // gateway 對 IdP 那一腿自建一組 PKCE。
        const idpPkce = createPkcePair();
        const pending = deps.sessions.rememberAuthorization({
            launchId,
            clientId,
            appRedirectUri,
            state: params.get("state") ?? "",
            appCodeChallenge,
            idpCodeVerifier: idpPkce.codeVerifier,
        });

        const discovery = readIdpEndpoints(deps.tokenVerifier);
        const forwarded = new URL(discovery.authorization_endpoint);
        forwarded.searchParams.set("response_type", "code");
        forwarded.searchParams.set("client_id", deps.idpClientId);
        forwarded.searchParams.set("redirect_uri", callbackUrl(deps.publicBaseUrl, pending).toString());
        forwarded.searchParams.set("code_challenge", idpPkce.codeChallenge);
        forwarded.searchParams.set("code_challenge_method", PKCE_CHALLENGE_METHOD_S256);
        forwarded.searchParams.set("state", pending.state);
        for (const name of PASSTHROUGH_AUTHORIZATION_PARAMS) {
            const value = params.get(name);
            if (value !== null) {
                forwarded.searchParams.set(name, value);
            }
        }

        return redirect(forwarded.toString());
    }

    /**
     * IdP 認證完成後的 callback。**這是綁定點**：launch id 與 `sub` 在這一瞬間同時在手，
     * 寫進 store 之後才把存取權交給 App（ADR-0002）。
     *
     * App 收到的是 gateway 自己的一次性 opaque code，不是 token——gateway 不簽任何東西。
     */
    static async callback(request: Request, deps: SmartAuthorizationDeps): Promise<Response> {
        const params = new URL(request.url).searchParams;
        const pending = deps.sessions.findAuthorization(params.get("cid") ?? "");
        if (pending === undefined) {
            throw new OAuthError("invalid_request", "Unknown or already completed authorization.");
        }

        const idpError = params.get("error");
        if (idpError !== null) {
            // 使用者拒絕授權：照 OAuth 的形狀把錯誤送回 App，而不是停在 gateway 的錯誤頁。
            deps.sessions.discardAuthorization(pending.correlationId);
            const appRedirect = appendQuery(pending.appRedirectUri, {
                error: idpError,
                error_description: params.get("error_description") ?? "",
                state: pending.state,
            });
            return redirect(appRedirect);
        }

        const state = params.get("state") ?? "";
        // state 不符就拒絕綁定：攻擊者不能把自己的 code 塞進受害者的瀏覽器（ADR-0002 的 CSRF 防線）。
        if (!constantTimeEquals(state, pending.state)) {
            throw new OAuthError("invalid_request", "The state does not match the authorization that started here.");
        }

        const code = params.get("code") ?? "";
        if (code.length === 0) {
            throw new OAuthError("invalid_request", "The identity provider returned no authorization code.");
        }

        const discovery = readIdpEndpoints(deps.tokenVerifier);
        const tokens = await new IdpTokenExchangeService({
            tokenEndpoint: discovery.token_endpoint,
            clientId: deps.idpClientId,
            clientSecret: deps.idpClientSecret,
        }).exchangeAuthorizationCode({
            code,
            redirectUri: callbackUrl(deps.publicBaseUrl, pending).toString(),
            codeVerifier: pending.idpCodeVerifier,
        });

        // 只用「經過驗簽的」token 決定綁到誰：未驗證的 `sub` 不足以支撐一筆授權事實。
        const verified = await deps.tokenVerifier.decodeAndVerifyBearerToken(`Bearer ${tokens.accessToken}`);
        const subject = verified.payload.sub;
        if (subject === undefined || subject.length === 0) {
            throw new OAuthError("invalid_grant", "The identity provider issued a token without a subject.");
        }

        // 綁定索引鍵是 `(subject, client id)`：client id 取 App 的，不是 gateway 自己的 IdP
        // client——code exchange 是 gateway 做的，token 的 `azp` 會是 gateway 自己。
        const bound = await deps.store.bind(pending.launchId, subject, pending.clientId);
        if (bound === undefined) {
            throw new OAuthError(
                "invalid_grant",
                "The launch could not be bound; it may have expired or already been used.",
            );
        }
        deps.sessions.discardAuthorization(pending.correlationId);

        const issued: IssuedAuthorization = {
            accessToken: tokens.accessToken,
            ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
            tokenType: tokens.tokenType,
            scope: tokens.scope ?? "",
            appCodeChallenge: pending.appCodeChallenge,
            appRedirectUri: pending.appRedirectUri,
            clientId: pending.clientId,
            ...(tokens.expiresInSeconds !== undefined ? { expiresInSeconds: tokens.expiresInSeconds } : {}),
        };
        const gatewayCode = deps.sessions.issueAuthorizationCode(issued);

        return redirect(appendQuery(pending.appRedirectUri, { code: gatewayCode, state: pending.state }));
    }

    /**
     * gateway 自己的 token endpoint：`authorization_code` 與 `refresh_token` 兩種 grant 都走這裡。
     *
     * App 交來的 `code_verifier` 在這裡驗——因為實際的 code exchange 是 gateway 做的，
     * App 的 verifier 不會送到 IdP，所以這道檢查沒有別的地方會做。只接受 S256。
     */
    static async token(request: Request, deps: SmartAuthorizationDeps): Promise<Response> {
        const form = await readTokenRequest(request);
        const grantType = form.get("grant_type") ?? "";

        if (grantType === "authorization_code") {
            return SmartAuthorizationController.exchangeCode(form, deps);
        }

        if (grantType === "refresh_token") {
            return SmartAuthorizationController.refreshGrant(form, deps);
        }

        throw new OAuthError("unsupported_grant_type", "Only authorization_code and refresh_token are supported.");
    }

    private static async exchangeCode(form: URLSearchParams, deps: SmartAuthorizationDeps): Promise<Response> {
        // 單次使用：取出的當下就作廢，即使後面的 PKCE 檢查失敗也不能再用。
        const issued = deps.sessions.consumeAuthorizationCode(form.get("code") ?? "");
        if (issued === undefined) {
            throw new OAuthError("invalid_grant", "The authorization code is unknown or has already been used.");
        }

        if (!matchesS256Challenge(form.get("code_verifier") ?? "", issued.appCodeChallenge)) {
            throw new OAuthError("invalid_grant", "The code verifier does not match the code challenge.");
        }

        const redirectUri = form.get("redirect_uri");
        if (redirectUri !== null && redirectUri !== issued.appRedirectUri) {
            throw new OAuthError("invalid_grant", "The redirect URI does not match the authorization request.");
        }

        const clientId = form.get("client_id");
        if (clientId !== null && clientId !== issued.clientId) {
            throw new OAuthError("invalid_grant", "The client does not match the authorization request.");
        }

        return tokenResponse(issued);
    }

    private static async refreshGrant(form: URLSearchParams, deps: SmartAuthorizationDeps): Promise<Response> {
        const refreshToken = form.get("refresh_token") ?? "";
        const issued = deps.sessions.findRefreshToken(refreshToken);
        if (issued === undefined) {
            throw new OAuthError("invalid_grant", "The refresh token is unknown or has already been rotated.");
        }

        const clientId = form.get("client_id");
        if (clientId !== null && clientId !== issued.clientId) {
            throw new OAuthError("invalid_grant", "The client does not match the authorization request.");
        }

        const discovery = readIdpEndpoints(deps.tokenVerifier);
        const tokens = await new IdpTokenExchangeService({
            tokenEndpoint: discovery.token_endpoint,
            clientId: deps.idpClientId,
            clientSecret: deps.idpClientSecret,
        }).refresh(refreshToken);

        if (tokens.refreshToken === undefined) {
            throw new OAuthError("invalid_grant", "The identity provider did not issue a new refresh token.");
        }

        const refreshed: IssuedAuthorization = {
            ...issued,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            tokenType: tokens.tokenType,
            ...(tokens.expiresInSeconds !== undefined ? { expiresInSeconds: tokens.expiresInSeconds } : {}),
        };
        deps.sessions.rotateRefreshToken(refreshToken, refreshed);

        return tokenResponse(refreshed);
    }
}

/** 把 OAuth 的錯誤形狀回給 App；內部原因留在日誌與 cause，不對外。 */
export function oauthErrorResponse(error: OAuthError): Response {
    if (error.cause !== undefined) {
        console.error(`[smart-authorization] ${error.error}: ${error.message}`, error.cause);
    } else {
        console.warn(`[smart-authorization] ${error.error}: ${error.message}`);
    }
    return Response.json(
        { error: error.error, error_description: error.message },
        { status: error.error === "server_error" ? 500 : 400, headers: NO_STORE_HEADERS },
    );
}

function requireParam(params: URLSearchParams, name: string): string {
    const value = params.get(name);
    if (value === null || value.length === 0) {
        throw new OAuthError("invalid_request", `The ${name} parameter is required.`);
    }
    return value;
}

/**
 * IdP 的 authorization／token endpoint 來自啟動時快取的 discovery 文件——同一份 gateway
 * 已經在用的設定快照，不在請求路徑上另外發一次連線。
 */
function readIdpEndpoints(tokenVerifier: TokenVerifierService): OidcDiscovery {
    const parsed = OidcDiscoverySchema.safeParse(parseJson(tokenVerifier.getWellKnownConfig()));
    if (!parsed.success) {
        throw new OAuthError("server_error", "The identity provider's discovery document is not usable.");
    }
    return parsed.data;
}

/** gateway 自己的 callback：correlation id 放在 query 上，讓 callback 找回那一次 `authorize`。 */
function callbackUrl(publicBaseUrl: string, pending: PendingAuthorization): URL {
    const url = new URL(smartEndpointUrl(publicBaseUrl, `${SMART_API_PREFIX}${SMART_CALLBACK_PATH}`));
    url.searchParams.set("cid", pending.correlationId);
    return url;
}

function appendQuery(redirectUri: string, params: Record<string, string>): string {
    const url = new URL(redirectUri);
    for (const [name, value] of Object.entries(params)) {
        url.searchParams.set(name, value);
    }
    return url.toString();
}

function redirect(location: string): Response {
    return new Response(null, { status: 302, headers: { location, ...NO_STORE_HEADERS } });
}

function tokenResponse(issued: IssuedAuthorization): Response {
    return Response.json(
        {
            access_token: issued.accessToken,
            token_type: issued.tokenType,
            ...(issued.refreshToken !== undefined ? { refresh_token: issued.refreshToken } : {}),
            ...(issued.expiresInSeconds !== undefined ? { expires_in: issued.expiresInSeconds } : {}),
            ...(issued.scope.length > 0 ? { scope: issued.scope } : {}),
        },
        { headers: NO_STORE_HEADERS },
    );
}

/** token endpoint 的 body：標準是 form-urlencoded，但有些 SMART App 送 JSON，兩種都收。 */
async function readTokenRequest(request: Request): Promise<URLSearchParams> {
    const body = await request.text();
    if (request.headers.get("content-type")?.includes("application/json") === true) {
        const json = parseJson(body);
        if (json === undefined || typeof json !== "object" || json === null) {
            throw new OAuthError("invalid_request", "The token request body must be a JSON object.");
        }
        const form = new URLSearchParams();
        for (const [name, value] of Object.entries(json)) {
            if (typeof value === "string") {
                form.set(name, value);
            }
        }
        return form;
    }
    return new URLSearchParams(body);
}

function parseJson(body: string): unknown {
    try {
        return JSON.parse(body) as unknown;
    } catch {
        return undefined;
    }
}
