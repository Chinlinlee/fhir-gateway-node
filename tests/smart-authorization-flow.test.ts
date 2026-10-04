import { type CryptoKey, decodeJwt } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type App, createApp } from "../src/app";
import type { GatewayConfig } from "../src/configs/env.schema";
import {
    FHIR_API_PREFIX,
    SMART_API_PREFIX,
    SMART_AUTHORIZE_PATH,
    SMART_TOKEN_PATH,
    WELL_KNOWN_SMART_CONFIGURATION_PATH,
} from "../src/constants/routes";
import { AllowedQueriesCheckerService } from "../src/services/allowed-queries.service";
import { InMemoryLaunchContextStore } from "../src/services/launch-context-store.service";
import { PatientFinderService } from "../src/services/patient-finder.service";
import { TokenVerifierService } from "../src/services/token-verifier.service";
import { allowedQueriesFixturePath } from "./helpers/allowed-queries-fixture";
import { type IssuerTestServer, startIssuerTestServer } from "./helpers/issuer-test-server";
import {
    APP_AUTHORIZE_SCOPE,
    APP_CLIENT_ID,
    APP_REDIRECT_URI,
    APP_STATE,
    AUTHORIZED_PATIENT,
    authenticateAtIdp,
    authorizeParams,
    CLINICIAN_SUBJECT,
    CODE_VERIFIER,
    createBaseConfig,
    GATEWAY_BASE_URL,
    GATEWAY_IDP_CLIENT_ID,
    GATEWAY_IDP_CLIENT_SECRET,
    gatewayAuthorize,
    gatewayToken,
    INTERNAL_CREDENTIAL,
    locationOf,
    OTHER_PATIENT,
    signAccessToken,
    startUpstreamServer,
    type UpstreamServer,
} from "./helpers/launch-flow-fixture";

/**
 * 一份未修改的標準 SMART App：它只知道 SMART 的兩個端點與 PKCE，除此之外對 gateway
 * 沒有任何特別設定。`GATEWAY_BASE_URL` 是 operator 設定的 gateway public base URL。
 *
 * 請求形狀與 stub 全部來自 `helpers/launch-flow-fixture`——同一條 launch 路徑的另外幾組測試
 * 也用它，兩邊的差異才會只剩下這一份檔案要驗的東西。
 */

/** App 的 redirect_uri 上帶回來的 `code`：gateway 自己發的一次性不透明 handle。 */
type Launch = {
    gatewayCode: string;
    state: string | null;
    origin: string;
    path: string;
};

describe("SMART authorization flow proxied by the gateway", () => {
    let issuer: IssuerTestServer;
    let upstream: UpstreamServer;
    let tokenVerifier: TokenVerifierService;
    let store: InMemoryLaunchContextStore;

    beforeEach(async () => {
        issuer = await startIssuerTestServer("test", {
            serveAuthorizationFlow: true,
            clientId: GATEWAY_IDP_CLIENT_ID,
            clientSecret: GATEWAY_IDP_CLIENT_SECRET,
            subject: CLINICIAN_SUBJECT,
        });
        upstream = await startUpstreamServer();
        tokenVerifier = await TokenVerifierService.create({
            tokenIssuer: issuer.issuerUrl,
            wellKnownEndpoint: issuer.wellKnownPath,
            runMode: "PROD",
            allowTokenIssuerHostMismatch: false,
        });
        store = new InMemoryLaunchContextStore();
    });

    afterEach(async () => {
        await issuer.close();
        await upstream.close();
    });

    const buildApp = (overrides: Partial<GatewayConfig> = {}) => {
        const config = createBaseConfig({
            tokenIssuer: issuer.issuerUrl,
            proxyTo: upstream.baseUrl,
            allowedQueriesFile: allowedQueriesFixturePath("allowed_unauthenticated_queries.json"),
            accessChecker: "basic",
            ...overrides,
        });
        return createApp({
            tokenVerifier,
            config,
            allowedQueries: AllowedQueriesCheckerService.loadFromFile(config.allowedQueriesFile),
            patientFinder: PatientFinderService.getInstance(),
            launchContextStore: store,
        });
    };

    /** EHR 在 App 開啟前建立 launch context，拿到 gateway 生成的 launch id。 */
    const registerLaunchContext = async (app: App): Promise<string> => {
        const response = await app.handle(
            new Request("http://localhost/internal/launch-contexts", {
                method: "POST",
                headers: { "content-type": "application/json", "x-internal-credential": INTERNAL_CREDENTIAL },
                body: JSON.stringify({ patientId: AUTHORIZED_PATIENT }),
            }),
        );
        expect(response.status).toBe(201);
        const body = (await response.json()) as { launchId: string };
        return body.launchId;
    };

    /** 跑完整條瀏覽器路徑：authorize → IdP → gateway callback → App 的 redirect_uri。 */
    const runLaunch = async (app: App, params: URLSearchParams): Promise<Launch> => {
        const idpRedirect = await locationOf(await app.handle(gatewayAuthorize(params)));
        const gatewayCallback = await authenticateAtIdp(idpRedirect);
        const appRedirect = await locationOf(await app.handle(new Request(gatewayCallback, { redirect: "manual" })));

        return {
            gatewayCode: appRedirect.searchParams.get("code") ?? "",
            state: appRedirect.searchParams.get("state"),
            origin: appRedirect.origin,
            path: appRedirect.pathname,
        };
    };

    const exchangeCode = async (app: App, launch: Launch, overrides: Record<string, string> = {}) =>
        app.handle(
            gatewayToken({
                grant_type: "authorization_code",
                code: launch.gatewayCode,
                redirect_uri: APP_REDIRECT_URI,
                client_id: APP_CLIENT_ID,
                code_verifier: CODE_VERIFIER,
                ...overrides,
            }),
        );

    /** 自己簽一張 IdP access token；它的 `jti` 從未經過 token endpoint，因此沒有任何綁定。 */
    const signUnboundToken = async (): Promise<string> =>
        await signAccessToken(issuer.issuerUrl, issuer.keys.privateKey as CryptoKey, {
            jti: "state-mismatch-never-attached",
            scope: "patient/Patient.read",
        });

    it("completes a full SMART launch and serves FHIR with the token it obtained", async () => {
        const app = buildApp();
        const launchId = await registerLaunchContext(app);

        const completed = await runLaunch(app, authorizeParams(launchId));

        expect(completed.origin + completed.path).toBe(APP_REDIRECT_URI);
        expect(completed.state).toBe(APP_STATE);

        const tokenResponse = await exchangeCode(app, completed);
        expect(tokenResponse.status).toBe(200);

        const tokens = (await tokenResponse.json()) as {
            access_token: string;
            refresh_token: string;
            token_type: string;
        };
        expect(tokens.refresh_token).not.toBe("");
        expect(tokens.token_type).toBe("Bearer");
        // App 拿到的 access token 仍然是 IdP 簽發的，issuer 檢查不必改寫
        expect(decodeJwt(tokens.access_token).iss).toBe(issuer.issuerUrl);

        const fhirResponse = await app.handle(
            new Request(`${GATEWAY_BASE_URL}${FHIR_API_PREFIX}/Patient/${AUTHORIZED_PATIENT}`, {
                headers: { Authorization: `Bearer ${tokens.access_token}` },
            }),
        );
        expect(fhirResponse.status).toBe(200);

        // 實際的 code exchange 是 gateway 做的：用的是 gateway 自己的 IdP client 憑證，
        // 而 App 的 code_verifier 不會送到 IdP（PKCE 由 gateway 自己驗）
        expect(issuer.observations.token?.["client_id"]).toBe(GATEWAY_IDP_CLIENT_ID);
        expect(issuer.observations.token?.["client_secret"]).toBe(GATEWAY_IDP_CLIENT_SECRET);
        expect(issuer.observations.token?.["code_verifier"]).not.toBe(CODE_VERIFIER);
    });

    it("serves FHIR to the patient the callback bound, so the store can serve it back", async () => {
        // patient 模式：basic 模式不檢查 launch context，用它驗不出綁定有沒有生效。
        const app = buildApp({ accessChecker: "patient" });
        const launchId = await registerLaunchContext(app);

        const completed = await runLaunch(app, authorizeParams(launchId));
        const tokenResponse = await exchangeCode(app, completed);
        expect(tokenResponse.status).toBe(200);
        const tokens = (await tokenResponse.json()) as { access_token: string };

        // 可觀察的結果就是這兩行：這張 token 被授權到 callback 綁定的那位病人，只有那位。
        const allowed = await app.handle(
            new Request(`${GATEWAY_BASE_URL}${FHIR_API_PREFIX}/Patient/${AUTHORIZED_PATIENT}`, {
                headers: { Authorization: `Bearer ${tokens.access_token}` },
            }),
        );
        const denied = await app.handle(
            new Request(`${GATEWAY_BASE_URL}${FHIR_API_PREFIX}/Patient/${OTHER_PATIENT}`, {
                headers: { Authorization: `Bearer ${tokens.access_token}` },
            }),
        );

        expect(allowed.status).toBe(200);
        expect(denied.status).toBe(403);
    });

    it("hands out an opaque code that carries no identity and no patient reference", async () => {
        const app = buildApp();
        const launchId = await registerLaunchContext(app);

        const completed = await runLaunch(app, authorizeParams(launchId));

        // 不透明 handle：不是 JWT，解不出 payload，也沒有任何身分或病人資訊
        expect(completed.gatewayCode.split(".")).toHaveLength(1);
        expect(completed.gatewayCode).not.toContain(CLINICIAN_SUBJECT);
        expect(completed.gatewayCode).not.toContain(AUTHORIZED_PATIENT);
        expect(() => decodeJwt(completed.gatewayCode)).toThrow();
    });

    it("advertises its own authorization and token endpoints while keeping the IdP issuer", async () => {
        const app = buildApp();

        // 請求自己的 Host 是別的名字：端點改寫必須來自設定，不是從 Host header 推導
        const response = await app.handle(
            new Request(`http://attacker.example${FHIR_API_PREFIX}/${WELL_KNOWN_SMART_CONFIGURATION_PATH}`),
        );

        expect(response.status).toBe(200);
        const body = (await response.json()) as Record<string, string>;
        const idpDiscovery = JSON.parse(issuer.wellKnownConfig) as Record<string, string>;
        // issuer 維持 IdP 的原值：access token 的 `iss` 仍然是 IdP，App 的 issuer 檢查才一致
        expect(body.issuer).toBe(idpDiscovery.issuer);
        expect(body.authorization_endpoint).toBe(`${GATEWAY_BASE_URL}${SMART_API_PREFIX}${SMART_AUTHORIZE_PATH}`);
        expect(body.token_endpoint).toBe(`${GATEWAY_BASE_URL}${SMART_API_PREFIX}${SMART_TOKEN_PATH}`);
    });

    it("forwards launch, state, scope, aud and nonce to the IdP with its own callback as redirect_uri", async () => {
        const app = buildApp();
        const launchId = await registerLaunchContext(app);

        const idpRedirect = await locationOf(await app.handle(gatewayAuthorize(authorizeParams(launchId))));
        expect(idpRedirect.origin).toBe(issuer.issuerUrl);
        // 真的打到 IdP：那裡看到的參數就是 gateway 轉發出去的內容
        await authenticateAtIdp(idpRedirect);

        const forwarded = issuer.observations.authorize;
        expect(forwarded?.["launch"]).toBe(launchId);
        expect(forwarded?.["state"]).toBe(APP_STATE);
        expect(forwarded?.["scope"]).toBe(APP_AUTHORIZE_SCOPE);
        expect(forwarded?.["aud"]).toBe("https://fhir.example");
        expect(forwarded?.["nonce"]).toBe("n-0S6_WzA2Mj");
        expect(forwarded?.["client_id"]).toBe(GATEWAY_IDP_CLIENT_ID);
        // 不改寫 redirect_uri 就不成立：callback 不經過 gateway，綁定不可能發生
        expect(forwarded?.["redirect_uri"]).toContain(`${GATEWAY_BASE_URL}${SMART_API_PREFIX}/callback`);
        expect(forwarded?.["redirect_uri"]).not.toBe(APP_REDIRECT_URI);
        // App 的 PKCE 由 gateway 自己驗證，因此這裡是 gateway 對 IdP 那一腿自建的 challenge
        expect(forwarded?.["code_challenge"]).not.toBe(CODE_VERIFIER);
        expect(forwarded?.["code_challenge_method"]).toBe("S256");
    });

    it("rejects an unknown launch id without forwarding it to the IdP", async () => {
        const app = buildApp();

        const response = await app.handle(gatewayAuthorize(authorizeParams("not-a-launch-id")));

        expect(response.status).toBe(400);
        expect(issuer.requests.authorize).toBe(0);
    });

    it("rejects a launch id that was already used for a binding", async () => {
        const app = buildApp();
        const launchId = await registerLaunchContext(app);
        await runLaunch(app, authorizeParams(launchId));

        const replayed = await app.handle(gatewayAuthorize(authorizeParams(launchId)));

        expect(replayed.status).toBe(400);
        expect(issuer.requests.authorize).toBe(1);
    });

    it("refuses to bind when the state at callback does not match the one recorded at authorize", async () => {
        const app = buildApp({ accessChecker: "patient" });
        const launchId = await registerLaunchContext(app);

        const idpRedirect = await locationOf(await app.handle(gatewayAuthorize(authorizeParams(launchId))));
        const gatewayCallback = await authenticateAtIdp(idpRedirect);
        const tampered = new URL(gatewayCallback);
        tampered.searchParams.set("state", "attacker-state");

        const response = await app.handle(new Request(tampered, { redirect: "manual" }));

        expect(response.status).toBe(400);
        // state 不符就不綁定，因此這位醫師的下一張 token 仍然拿不到病人。
        const noBinding = await app.handle(
            new Request(`${GATEWAY_BASE_URL}${FHIR_API_PREFIX}/Patient/${AUTHORIZED_PATIENT}`, {
                headers: {
                    Authorization: `Bearer ${await signUnboundToken()}`,
                },
            }),
        );
        expect(noBinding.status).toBe(401);
    });

    it("rejects a gateway code that is exchanged twice", async () => {
        const app = buildApp();
        const launchId = await registerLaunchContext(app);
        const completed = await runLaunch(app, authorizeParams(launchId));

        expect((await exchangeCode(app, completed)).status).toBe(200);
        const replay = await exchangeCode(app, completed);

        expect(replay.status).toBe(400);
    });

    it("rejects the code exchange when code_verifier is missing or does not match", async () => {
        const app = buildApp();
        const launchId = await registerLaunchContext(app);
        const completed = await runLaunch(app, authorizeParams(launchId));

        const withoutVerifier = await exchangeCode(app, completed, { code_verifier: "" });
        const wrongVerifier = await exchangeCode(app, completed, { code_verifier: `${CODE_VERIFIER}-wrong` });

        expect(withoutVerifier.status).toBe(400);
        expect(wrongVerifier.status).toBe(400);
    });

    it("rejects an authorize request that asks for a code challenge method other than S256", async () => {
        const app = buildApp();
        const launchId = await registerLaunchContext(app);

        const response = await app.handle(
            gatewayAuthorize(authorizeParams(launchId, { code_challenge_method: "plain" })),
        );

        expect(response.status).toBe(400);
        expect(issuer.requests.authorize).toBe(0);
    });

    it("exchanges a refresh token at the same token endpoint and returns new IdP tokens", async () => {
        const app = buildApp();
        const launchId = await registerLaunchContext(app);
        const completed = await runLaunch(app, authorizeParams(launchId));
        const tokenResponse = await exchangeCode(app, completed);
        const first = (await tokenResponse.json()) as { access_token: string; refresh_token: string };

        const refreshResponse = await app.handle(
            gatewayToken({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: APP_CLIENT_ID }),
        );

        expect(refreshResponse.status).toBe(200);
        // refresh 真的走回 IdP 換 token：gateway 自己不簽任何東西
        expect(issuer.requests.token).toBe(2);
        const refreshed = (await refreshResponse.json()) as { access_token: string; refresh_token: string };
        expect(refreshed.refresh_token).not.toBe(first.refresh_token);
        expect(decodeJwt(refreshed.access_token).iss).toBe(issuer.issuerUrl);
    });
});
