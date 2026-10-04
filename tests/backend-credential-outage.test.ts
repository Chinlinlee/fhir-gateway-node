import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type CryptoKey, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type App, createApp } from "../src/app";
import type { GatewayConfig } from "../src/configs/env.schema";
import { FHIR_API_PREFIX } from "../src/constants/routes";
import { AuthenticationError } from "../src/errors/authentication.error";
import { BACKEND_CREDENTIAL_UNAVAILABLE_MESSAGE } from "../src/errors/backend-credential.error";
import { createDefaultAccessCheckerRegistry } from "../src/services/access-checker-registry.service";
import { FhirBackendService } from "../src/services/fhir-backend.service";
import { GcpAccessTokenProviderService } from "../src/services/gcp-access-token-provider.service";
import { HttpFhirClientService } from "../src/services/http-fhir-client.service";
import { TokenVerifierService } from "../src/services/token-verifier.service";
import type { AccessChecker, AccessCheckerFactory } from "../src/types/access-checker";
import { accessGranted } from "../src/types/access-decision";
import { type IssuerTestServer, startIssuerTestServer } from "./helpers/issuer-test-server";

const PATIENT_ID = "456";

/**
 * `google-auth-library` 讀不到 ADC 時的錯誤形狀：訊息裡帶著憑證檔的**絕對路徑**。
 * 這正是不可外洩的內容。
 */
const ADC_CREDENTIALS_PATH = "C:\\Users\\gateway\\.config\\gcloud\\application_default_credentials.json";

/** gateway 自己的 ADC 故障：轉發與後端查詢共用的 access token 取不到。 */
async function brokenGcpAccessToken(): Promise<string> {
    throw new Error(
        `Unable to read the credential file specified by the GOOGLE_APPLICATION_CREDENTIALS environment variable: The file at ${ADC_CREDENTIALS_PATH} does not exist, or it is not a file.`,
    );
}

type UpstreamServer = {
    baseUrl: string;
    /** gateway 轉發到 FHIR upstream 的請求路徑；憑證故障時應該一個都沒有。 */
    proxiedPaths: string[];
    close: () => Promise<void>;
};

async function startUpstreamServer(
    respond: (requestPath: string) => { status: number; body: string } = () => ({
        status: 200,
        body: JSON.stringify({ resourceType: "Patient", id: PATIENT_ID }),
    }),
): Promise<UpstreamServer> {
    const proxiedPaths: string[] = [];
    const server: Server = createServer((req, res) => {
        const requestPath = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        proxiedPaths.push(requestPath);
        const { status, body } = respond(requestPath);
        res.writeHead(status, { "content-type": "application/fhir+json" });
        res.end(body);
    });

    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Unable to bind upstream test server");
    }

    return {
        baseUrl: `http://127.0.0.1:${address.port}/fhir`,
        proxiedPaths,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            }),
    };
}

/**
 * 自訂 access checker 在授權階段（prepare）查 backend —— README 文件化的擴充點：
 * `ACCESS_CHECKER=list` 之外要查 backend 的自訂 checker，請在建構時自行注入 `fhirBackend`。
 * backend 憑證的取得失敗正是從這裡冒到 controller 的。
 */
const backendQueryCheckerFactory: AccessCheckerFactory = {
    create(context): AccessChecker {
        const fhirBackend = context.fhirBackend;
        if (!fhirBackend) {
            throw new AuthenticationError("backendQuery checker requires fhirBackend");
        }
        return {
            prepare: async (): Promise<void> => {
                await fhirBackend.getResource(`/Patient?_id=${PATIENT_ID}`);
            },
            checkAccess: () => accessGranted(),
        };
    },
};

function readPatient(app: App, jwt: string): Promise<Response> {
    return app.handle(
        new Request(`http://localhost${FHIR_API_PREFIX}/Patient/${PATIENT_ID}`, {
            headers: { Authorization: `Bearer ${jwt}` },
        }),
    );
}

describe("gateway-side backend credential outage over the app seam", () => {
    let issuer: IssuerTestServer;
    let upstream: UpstreamServer;
    let tokenVerifier: TokenVerifierService;

    beforeEach(async () => {
        issuer = await startIssuerTestServer("test");
        upstream = await startUpstreamServer();
        tokenVerifier = await TokenVerifierService.create({
            tokenIssuer: issuer.issuerUrl,
            wellKnownEndpoint: issuer.wellKnownPath,
            runMode: "PROD",
            allowTokenIssuerHostMismatch: false,
        });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await issuer.close();
        await upstream.close();
    });

    function createConfig(): GatewayConfig {
        return {
            proxyTo: upstream.baseUrl,
            tokenIssuer: issuer.issuerUrl,
            // GCP 部署：gateway 自己的 ADC 才是轉發與後端查詢的憑證來源
            backendType: "GCP",
            accessChecker: "backend-query",
            auditEventActions: [],
            wellKnownEndpoint: issuer.wellKnownPath,
            runMode: "PROD",
            allowTokenIssuerHostMismatch: false,
            port: 3000,
        };
    }

    /**
     * 建立一個「gateway 自己的 ADC 壞掉」的 app：轉發 client 與後端查詢共用同一組
     * （壞掉的）憑證，與 `BACKEND_TYPE=GCP` 的真實部署一致。
     */
    function createAppWithBrokenBackendCredential(): App {
        const registry = createDefaultAccessCheckerRegistry();
        registry.register("backend-query", backendQueryCheckerFactory);

        return createApp({
            tokenVerifier,
            config: createConfig(),
            accessCheckerRegistry: registry,
            httpFhirClient: new HttpFhirClientService({
                proxyTo: upstream.baseUrl,
                backendType: "GCP",
                getGcpAccessToken: brokenGcpAccessToken,
            }),
            fhirBackend: new FhirBackendService({
                baseUrl: upstream.baseUrl,
                getBearerToken: brokenGcpAccessToken,
            }),
        });
    }

    async function signJwt(
        privateKey: CryptoKey,
        claims: Record<string, string>,
        options: { kid?: string; expired?: boolean } = {},
    ): Promise<string> {
        const builder = new SignJWT(claims)
            .setProtectedHeader({ alg: "RS256", ...(options.kid ? { kid: options.kid } : {}) })
            .setIssuer(issuer.issuerUrl)
            .setSubject("gateway-user");
        return await (options.expired ? builder.setExpirationTime(-60) : builder).sign(privateKey);
    }

    it("answers a gateway-side credential outage with 503 and a redacted message", async () => {
        const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const app = createAppWithBrokenBackendCredential();
        const jwt = await signJwt(issuer.keys.privateKey, { scope: "patient/Patient.read" });

        const response = await readPatient(app, jwt);

        expect(response.status).toBe(503);
        const raw = await response.text();
        // 對外只給固定的、可行動的訊息；provider 原始錯誤與本機檔案路徑一律不外洩
        expect(raw).not.toContain(ADC_CREDENTIALS_PATH);
        expect(raw).not.toContain("GOOGLE_APPLICATION_CREDENTIALS");
        const body = JSON.parse(raw) as { issue?: Array<{ code?: string; diagnostics?: string }> };
        expect(body.issue?.[0]?.code).toBe("transient");
        expect(body.issue?.[0]?.diagnostics).toBe(BACKEND_CREDENTIAL_UNAVAILABLE_MESSAGE);
        // 原始原因（含檔案路徑）留在 server log，而且這次請求是以 5xx 紀錄，不是 401
        expect(logged).toHaveBeenCalledWith(expect.stringContaining("[fhir-proxy] 503"));
        expect(logged).toHaveBeenCalledWith(expect.stringContaining(ADC_CREDENTIALS_PATH));
        // gateway 自己的憑證就壞掉時不該還去動 FHIR upstream
        expect(upstream.proxiedPaths).toEqual([]);
    });

    it("still answers 401 for an ordinary expired client token", async () => {
        const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const app = createAppWithBrokenBackendCredential();
        // client 端過期的 token：重新登入可修好，與 gateway 自己的憑證無關。
        // 這同時釘住「呼叫端無法在不真的弄壞 gateway 憑證的情況下誘導 5xx」。
        const expired = await signJwt(
            issuer.keys.privateKey,
            { scope: "patient/Patient.read" },
            { kid: issuer.keys.kid, expired: true },
        );

        const response = await readPatient(app, expired);

        expect(response.status).toBe(401);
        const raw = await response.text();
        expect(raw).not.toContain(ADC_CREDENTIALS_PATH);
        const body = JSON.parse(raw) as { issue?: Array<{ code?: string }> };
        expect(body.issue?.[0]?.code).toBe("login");
        expect(logged).toHaveBeenCalledWith(expect.stringContaining("[fhir-proxy] 401"));
        expect(logged).not.toHaveBeenCalledWith(expect.stringContaining("[fhir-proxy] 503"));
        expect(upstream.proxiedPaths).toEqual([]);
    });

    it("classifies a failing ADC lookup as a gateway-side fault without leaking the file path", async () => {
        const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const previous = process.env.GOOGLE_APPLICATION_CREDENTIALS;
        // 走真實的 google-auth-library 路徑：指向不存在的檔案，ADC 解析一定失敗
        const missingCredentials = join(tmpdir(), "fhir-gateway-adc-missing", "credentials.json");
        process.env.GOOGLE_APPLICATION_CREDENTIALS = missingCredentials;

        try {
            await expect(new GcpAccessTokenProviderService().getAccessToken()).rejects.toMatchObject({
                name: "BackendCredentialError",
                message: BACKEND_CREDENTIAL_UNAVAILABLE_MESSAGE,
            });
        } finally {
            if (previous === undefined) {
                delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
            } else {
                process.env.GOOGLE_APPLICATION_CREDENTIALS = previous;
            }
        }

        // 原始的 google-auth-library 訊息（含絕對路徑）只留在 server log
        const serverLog = logged.mock.calls.map((call) => String(call[0])).join("\n");
        expect(serverLog).toContain("cannot obtain an ADC access token");
        expect(serverLog).toContain(missingCredentials);
    });
});

/**
 * 轉發階段才解析的憑證：`permissive` checker 完全不碰 `fhirBackend`，所以 ADC 故障
 * 只可能發生在 `HttpFhirClientService.handleRequest` 取 token 的那一刻 ——
 * 也就是舊版會回 500 並夾帶 google-auth-library 絕對路徑的那條路徑。
 */
describe("gateway-side backend credential outage on the forwarding path", () => {
    let issuer: IssuerTestServer;
    let upstream: UpstreamServer;
    let tokenVerifier: TokenVerifierService;

    beforeEach(async () => {
        issuer = await startIssuerTestServer("test");
        upstream = await startUpstreamServer();
        tokenVerifier = await TokenVerifierService.create({
            tokenIssuer: issuer.issuerUrl,
            wellKnownEndpoint: issuer.wellKnownPath,
            runMode: "PROD",
            allowTokenIssuerHostMismatch: false,
        });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await issuer.close();
        await upstream.close();
    });

    function createConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
        return {
            proxyTo: upstream.baseUrl,
            tokenIssuer: issuer.issuerUrl,
            backendType: "GCP",
            accessChecker: "permissive",
            auditEventActions: [],
            wellKnownEndpoint: issuer.wellKnownPath,
            runMode: "PROD",
            allowTokenIssuerHostMismatch: false,
            port: 3000,
            ...overrides,
        };
    }

    async function signJwt(): Promise<string> {
        return await new SignJWT({ scope: "patient/Patient.read" })
            .setProtectedHeader({ alg: "RS256", kid: issuer.keys.kid })
            .setIssuer(issuer.issuerUrl)
            .setSubject("gateway-user")
            .setExpirationTime("5m")
            .sign(issuer.keys.privateKey);
    }

    it("answers a forwarding-time credential outage with 503 instead of a 500 leaking the ADC file path", async () => {
        const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const app = createApp({
            tokenVerifier,
            config: createConfig(),
            httpFhirClient: new HttpFhirClientService({
                proxyTo: upstream.baseUrl,
                backendType: "GCP",
                getGcpAccessToken: brokenGcpAccessToken,
            }),
        });
        const jwt = await signJwt();

        const response = await readPatient(app, jwt);

        expect(response.status).toBe(503);
        const raw = await response.text();
        // 對外不可出現 google-auth-library 的絕對路徑（舊版會以 500 夾帶出去）
        expect(raw).not.toContain(ADC_CREDENTIALS_PATH);
        expect(raw).not.toContain("GOOGLE_APPLICATION_CREDENTIALS");
        const body = JSON.parse(raw) as { issue?: Array<{ code?: string; diagnostics?: string }> };
        expect(body.issue?.[0]?.code).toBe("transient");
        expect(body.issue?.[0]?.diagnostics).toBe(BACKEND_CREDENTIAL_UNAVAILABLE_MESSAGE);
        // 原始原因（含檔案路徑）留在 server log，並且這次請求是以 5xx 紀錄，不是 401
        expect(logged).toHaveBeenCalledWith(expect.stringContaining("[fhir-proxy] 503"));
        expect(logged).toHaveBeenCalledWith(expect.stringContaining(ADC_CREDENTIALS_PATH));
        expect(logged).not.toHaveBeenCalledWith(expect.stringContaining("[fhir-proxy] 401"));
        // 憑證都取不到，根本不該打到 FHIR upstream
        expect(upstream.proxiedPaths).toEqual([]);
    });

    it("still forwards an upstream FHIR failure with the upstream status and body", async () => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        await upstream.close();
        upstream = await startUpstreamServer(() => ({
            status: 500,
            body: JSON.stringify({ resourceType: "OperationOutcome", issue: [{ code: "exception" }] }),
        }));
        const app = createApp({
            tokenVerifier,
            config: createConfig(),
            httpFhirClient: new HttpFhirClientService({
                proxyTo: upstream.baseUrl,
                backendType: "GCP",
                getGcpAccessToken: async () => "gateway-access-token",
            }),
        });
        const jwt = await signJwt();

        const response = await readPatient(app, jwt);

        // upstream 自己的 5xx 維持原樣，不可被誤判成 gateway 憑證故障
        expect(response.status).toBe(500);
        const raw = await response.text();
        expect(raw).not.toContain(BACKEND_CREDENTIAL_UNAVAILABLE_MESSAGE);
        expect(JSON.parse(raw)).toMatchObject({ resourceType: "OperationOutcome" });
        expect(upstream.proxiedPaths).toEqual([`/fhir/Patient/${PATIENT_ID}`]);
    });

    it("wires the GCP access token provider through the production bootstrap", async () => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        const config = createConfig();
        // 不注入 httpFhirClient：走 `createApp` 預設的建構路徑，`BACKEND_TYPE=GCP` 必須可啟動。
        const app = createApp({ tokenVerifier, config });
        const jwt = await signJwt();

        const response = await readPatient(app, jwt);

        // 測試環境沒有 ADC，因此以 503 收場 —— 證明 provider 有被接上，而不是建構期就炸掉。
        expect(response.status).toBe(503);
        expect(await response.text()).not.toContain("GCP backend requires getGcpAccessToken provider");
    });
});
