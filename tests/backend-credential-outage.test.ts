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

async function startUpstreamServer(): Promise<UpstreamServer> {
    const proxiedPaths: string[] = [];
    const server: Server = createServer((req, res) => {
        proxiedPaths.push(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
        res.writeHead(200, { "content-type": "application/fhir+json" });
        res.end(JSON.stringify({ resourceType: "Patient", id: PATIENT_ID }));
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
