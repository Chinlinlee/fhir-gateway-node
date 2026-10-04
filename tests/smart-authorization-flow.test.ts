import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

import { decodeJwt } from "jose";
import { fetch as undiciFetch } from "undici";
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
import { INTERNAL_CREDENTIAL_HEADER } from "../src/controllers/internal-launch/internal-launch.controller";
import { AllowedQueriesCheckerService } from "../src/services/allowed-queries.service";
import { InMemoryLaunchContextStore } from "../src/services/launch-context-store.service";
import { PatientFinderService } from "../src/services/patient-finder.service";
import { TokenVerifierService } from "../src/services/token-verifier.service";
import { allowedQueriesFixturePath } from "./helpers/allowed-queries-fixture";
import { type IssuerTestServer, startIssuerTestServer } from "./helpers/issuer-test-server";

/**
 * 一份未修改的標準 SMART App：它只知道 SMART 的兩個端點與 PKCE，除此之外對 gateway
 * 沒有任何特別設定。`GATEWAY_BASE_URL` 是 operator 設定的 gateway public base URL。
 */
const GATEWAY_BASE_URL = "https://gateway.example";
const APP_CLIENT_ID = "smart-app-client";
const APP_REDIRECT_URI = "https://app.example/callback";
const APP_STATE = "app-state-0S6_WzA2Mj";
const GATEWAY_IDP_CLIENT_ID = "gateway-idp-client";
const GATEWAY_IDP_CLIENT_SECRET = "gateway-idp-client-secret";
const INTERNAL_CREDENTIAL = "ehr-internal-credential";
const CODE_VERIFIER = "sBQnbpC_DdE9KZ1TLJKqzKvHqGHvVv0nQrTvVWkGWU8a";
const CODE_CHALLENGE = createHash("sha256").update(CODE_VERIFIER).digest("base64url");

type UpstreamServer = {
    baseUrl: string;
    close: () => Promise<void>;
};

type Launch = {
    /** App 的 redirect_uri 上帶回來的 `code`：gateway 自己發的一次性不透明 handle */
    gatewayCode: string;
    state: string | null;
    origin: string;
    path: string;
};

async function startUpstreamServer(): Promise<UpstreamServer> {
    const server: Server = createServer((req, res) => {
        const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;

        if (req.method === "GET" && path === "/fhir/Patient/456") {
            res.writeHead(200, { "content-type": "application/fhir+json" });
            res.end(JSON.stringify({ resourceType: "Patient", id: "456" }));
            return;
        }

        res.writeHead(404, { "content-type": "application/fhir+json" });
        res.end(JSON.stringify({ resourceType: "OperationOutcome" }));
    });

    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Unable to bind upstream test server");
    }

    return {
        baseUrl: `http://127.0.0.1:${address.port}/fhir`,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            }),
    };
}

function createBaseConfig(overrides: Partial<GatewayConfig>): GatewayConfig {
    return {
        proxyTo: "http://127.0.0.1:0/fhir",
        tokenIssuer: "http://token-issuer",
        backendType: "HAPI",
        accessChecker: "basic",
        auditEventActions: [],
        wellKnownEndpoint: "test",
        runMode: "PROD",
        allowTokenIssuerHostMismatch: false,
        port: 3000,
        gatewayPublicBaseUrl: GATEWAY_BASE_URL,
        gatewayClientId: GATEWAY_IDP_CLIENT_ID,
        gatewayClientSecret: GATEWAY_IDP_CLIENT_SECRET,
        internalLaunchApiEnabled: true,
        internalLaunchApiCredential: INTERNAL_CREDENTIAL,
        launchContextTtlSeconds: 600,
        ...overrides,
    };
}

/** App 的 `authorize` 請求參數；`launch` 由 EHR 建立 context 後取得。 */
function authorizeParams(launch: string, overrides: Record<string, string> = {}): URLSearchParams {
    return new URLSearchParams({
        response_type: "code",
        client_id: APP_CLIENT_ID,
        redirect_uri: APP_REDIRECT_URI,
        scope: "launch/patient patient/Patient.read openid fhirUser",
        aud: "https://fhir.example",
        launch,
        nonce: "n-0S6_WzA2Mj",
        state: APP_STATE,
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: "S256",
        ...overrides,
    });
}

function gatewayAuthorize(params: URLSearchParams): Request {
    return new Request(`${GATEWAY_BASE_URL}${SMART_API_PREFIX}${SMART_AUTHORIZE_PATH}?${params.toString()}`, {
        redirect: "manual",
    });
}

function gatewayToken(form: Record<string, string>): Request {
    return new Request(`${GATEWAY_BASE_URL}${SMART_API_PREFIX}${SMART_TOKEN_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
    });
}

/** 扮演使用者的瀏覽器：gateway 的 302 指向哪裡，這裡就走到哪裡。 */
async function locationOf(response: Response): Promise<URL> {
    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    return new URL(location ?? "");
}

/** 在 IdP 完成認證：IdP 302 回 gateway 自己的 callback。 */
async function authenticateAtIdp(idpRedirect: URL): Promise<URL> {
    const response = await undiciFetch(idpRedirect, { redirect: "manual" });
    return locationOf(response);
}

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
            subject: "clinician-42",
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
            new Request(`http://localhost/internal/launch-contexts`, {
                method: "POST",
                headers: { "content-type": "application/json", [INTERNAL_CREDENTIAL_HEADER]: INTERNAL_CREDENTIAL },
                body: JSON.stringify({ patientId: "456" }),
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

    it("completes a full SMART launch and serves FHIR with the token it obtained", async () => {
        const app = buildApp();
        const launch = await registerLaunchContext(app);

        const completed = await runLaunch(app, authorizeParams(launch));

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
            new Request(`${GATEWAY_BASE_URL}${FHIR_API_PREFIX}/Patient/456`, {
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

    it("binds the launch to the subject and client at the callback, so the store can serve it back", async () => {
        const app = buildApp();
        const launch = await registerLaunchContext(app);

        await runLaunch(app, authorizeParams(launch));

        const bound = await store.get("clinician-42", APP_CLIENT_ID);
        expect(bound?.launchId).toBe(launch);
        expect(bound?.patientId).toBe("456");
    });

    it("hands out an opaque code that carries no identity and no patient reference", async () => {
        const app = buildApp();
        const launch = await registerLaunchContext(app);

        const completed = await runLaunch(app, authorizeParams(launch));

        // 不透明 handle：不是 JWT，解不出 payload，也沒有任何身分或病人資訊
        expect(completed.gatewayCode.split(".")).toHaveLength(1);
        expect(completed.gatewayCode).not.toContain("clinician-42");
        expect(completed.gatewayCode).not.toContain("456");
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
        const launch = await registerLaunchContext(app);

        const idpRedirect = await locationOf(await app.handle(gatewayAuthorize(authorizeParams(launch))));
        expect(idpRedirect.origin).toBe(issuer.issuerUrl);
        // 真的打到 IdP：那裡看到的參數就是 gateway 轉發出去的內容
        await authenticateAtIdp(idpRedirect);

        const forwarded = issuer.observations.authorize;
        expect(forwarded?.["launch"]).toBe(launch);
        expect(forwarded?.["state"]).toBe(APP_STATE);
        expect(forwarded?.["scope"]).toBe("launch/patient patient/Patient.read openid fhirUser");
        expect(forwarded?.["aud"]).toBe("https://fhir.example");
        expect(forwarded?.["nonce"]).toBe("n-0S6_WzA2Mj");
        expect(forwarded?.["client_id"]).toBe(GATEWAY_IDP_CLIENT_ID);
        // 不改寫 redirect_uri 就不成立：callback 不經過 gateway，綁定不可能發生
        expect(forwarded?.["redirect_uri"]).toContain(`${GATEWAY_BASE_URL}${SMART_API_PREFIX}/callback`);
        expect(forwarded?.["redirect_uri"]).not.toBe(APP_REDIRECT_URI);
        // App 的 PKCE 由 gateway 自己驗證，因此這裡是 gateway 對 IdP 那一腿自建的 challenge
        expect(forwarded?.["code_challenge"]).not.toBe(CODE_CHALLENGE);
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
        const launch = await registerLaunchContext(app);
        await runLaunch(app, authorizeParams(launch));

        const replayed = await app.handle(gatewayAuthorize(authorizeParams(launch)));

        expect(replayed.status).toBe(400);
        expect(issuer.requests.authorize).toBe(1);
    });

    it("refuses to bind when the state at callback does not match the one recorded at authorize", async () => {
        const app = buildApp();
        const launch = await registerLaunchContext(app);

        const idpRedirect = await locationOf(await app.handle(gatewayAuthorize(authorizeParams(launch))));
        const gatewayCallback = await authenticateAtIdp(idpRedirect);
        const tampered = new URL(gatewayCallback);
        tampered.searchParams.set("state", "attacker-state");

        const response = await app.handle(new Request(tampered, { redirect: "manual" }));

        expect(response.status).toBe(400);
        expect(await store.get("clinician-42", APP_CLIENT_ID)).toBeUndefined();
    });

    it("rejects a gateway code that is exchanged twice", async () => {
        const app = buildApp();
        const launch = await registerLaunchContext(app);
        const completed = await runLaunch(app, authorizeParams(launch));

        expect((await exchangeCode(app, completed)).status).toBe(200);
        const replay = await exchangeCode(app, completed);

        expect(replay.status).toBe(400);
    });

    it("rejects the code exchange when code_verifier is missing or does not match", async () => {
        const app = buildApp();
        const launch = await registerLaunchContext(app);
        const completed = await runLaunch(app, authorizeParams(launch));

        const withoutVerifier = await exchangeCode(app, completed, { code_verifier: "" });
        const wrongVerifier = await exchangeCode(app, completed, { code_verifier: `${CODE_VERIFIER}-wrong` });

        expect(withoutVerifier.status).toBe(400);
        expect(wrongVerifier.status).toBe(400);
    });

    it("rejects an authorize request that asks for a code challenge method other than S256", async () => {
        const app = buildApp();
        const launch = await registerLaunchContext(app);

        const response = await app.handle(
            gatewayAuthorize(authorizeParams(launch, { code_challenge_method: "plain" })),
        );

        expect(response.status).toBe(400);
        expect(issuer.requests.authorize).toBe(0);
    });

    it("exchanges a refresh token at the same token endpoint and returns new IdP tokens", async () => {
        const app = buildApp();
        const launch = await registerLaunchContext(app);
        const completed = await runLaunch(app, authorizeParams(launch));
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
