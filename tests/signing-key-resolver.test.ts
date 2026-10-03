import { createServer, type Server } from "node:http";

import { SignJWT, exportJWK, generateKeyPair, importJWK, type CryptoKey } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type App, createApp } from "../src/app";
import type { GatewayConfig } from "../src/configs/env.schema";
import { ENV_KEYS, type SigningKeySource } from "../src/constants/config";
import { FHIR_API_PREFIX } from "../src/constants/routes";
import { StartupConnectionError } from "../src/errors/startup-connection.error";
import { PATIENT_CLAIM } from "../src/services/access-checkers/patient-access-checker.service";
import type { ResolvedSigningKeys, SigningKeyResolver } from "../src/services/signing-keys/signing-key-resolver";
import { TokenVerifierService } from "../src/services/token-verifier.service";
import type { HttpFetchFn } from "../src/utils/http.util";
import { HttpUtil } from "../src/utils/http.util";
import {
    type IssuerTestServer,
    type IssuerTestServerOptions,
    TEST_JWK_KID,
    startIssuerTestServer,
} from "./helpers/issuer-test-server";

const PATIENT_ID = "456";

type UpstreamServer = {
    baseUrl: string;
    close: () => Promise<void>;
};

async function startUpstreamServer(): Promise<UpstreamServer> {
    const server: Server = createServer((req, res) => {
        const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;

        if (req.method === "GET" && path === `/fhir/Patient/${PATIENT_ID}`) {
            res.writeHead(200, { "content-type": "application/fhir+json", etag: "W/1" });
            res.end(JSON.stringify({ resourceType: "Patient", id: PATIENT_ID }));
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
        close: async () => {
            const { promise, resolve, reject } = Promise.withResolvers<void>();
            server.close((error) => (error ? reject(error) : resolve()));
            await promise;
        },
    };
}

async function signPatientJwt(issuerUrl: string, privateKey: CryptoKey, kid?: string): Promise<string> {
    return await new SignJWT({
        [PATIENT_CLAIM]: PATIENT_ID,
        scope: "patient/Patient.read",
    })
        .setProtectedHeader({ alg: "RS256", ...(kid ? { kid } : {}) })
        .setIssuer(issuerUrl)
        .setSubject("gateway-user")
        .sign(privateKey);
}

function readPatient(app: App, jwt: string): Promise<Response> {
    return app.handle(
        new Request(`http://localhost${FHIR_API_PREFIX}/Patient/${PATIENT_ID}`, {
            headers: { Authorization: `Bearer ${jwt}` },
        }),
    );
}

function verifierConfig(
    issuer: { issuerUrl: string; wellKnownPath: string },
    signingKeySource?: SigningKeySource,
) {
    return {
        tokenIssuer: issuer.issuerUrl,
        wellKnownEndpoint: issuer.wellKnownPath,
        runMode: "PROD" as const,
        allowTokenIssuerHostMismatch: false,
        ...(signingKeySource ? { signingKeySource } : {}),
    };
}

function gatewayConfig(issuer: IssuerTestServer, upstream: UpstreamServer, signingKeySource?: SigningKeySource) {
    return {
        proxyTo: upstream.baseUrl,
        tokenIssuer: issuer.issuerUrl,
        backendType: "HAPI",
        accessChecker: "patient",
        auditEventActions: [],
        wellKnownEndpoint: issuer.wellKnownPath,
        runMode: "PROD",
        allowTokenIssuerHostMismatch: false,
        port: 3000,
        ...(signingKeySource ? { signingKeySource } : {}),
    } satisfies GatewayConfig;
}

/** 以指定的 trust path 建立真實 app（resolver 於啟動時解析） */
async function startGateway(
    issuer: IssuerTestServer,
    upstream: UpstreamServer,
    signingKeySource: SigningKeySource,
): Promise<App> {
    const tokenVerifier = await TokenVerifierService.create(verifierConfig(issuer, signingKeySource));
    return createApp({ tokenVerifier, config: gatewayConfig(issuer, upstream, signingKeySource) });
}

describe("SIGNING_KEY_SOURCE trust paths", () => {
    const closers: Array<() => Promise<void>> = [];

    async function startIssuer(options: IssuerTestServerOptions): Promise<IssuerTestServer> {
        const issuer = await startIssuerTestServer("test", options);
        closers.push(() => issuer.close());
        return issuer;
    }

    async function startUpstream(): Promise<UpstreamServer> {
        const upstream = await startUpstreamServer();
        closers.push(() => upstream.close());
        return upstream;
    }

    afterEach(async () => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        await Promise.all(closers.splice(0).map((close) => close()));
    });

    it("jwks — authorizes a correctly signed token from an IdP publishing only jwks_uri", async () => {
        const issuer = await startIssuer({ servePublicKey: false, serveJwks: true });
        const upstream = await startUpstream();
        const app = await startGateway(issuer, upstream, "jwks");

        const jwt = await signPatientJwt(issuer.issuerUrl, issuer.keys.privateKey, TEST_JWK_KID);
        const response = await readPatient(app, jwt);

        expect(response.status).toBe(200);
        const body = (await response.json()) as { id: string };
        expect(body.id).toBe(PATIENT_ID);
        // 明確選擇標準路徑時不得回退去讀 Keycloak 的 root public_key
        expect(issuer.requests.root).toBe(0);
        expect(issuer.requests.jwks).toBe(1);
    });

    it("keycloak-public-key — authorizes a correctly signed token from an IdP publishing only public_key", async () => {
        const issuer = await startIssuer({ serveJwks: false, publishJwksUri: false });
        const upstream = await startUpstream();
        const app = await startGateway(issuer, upstream, "keycloak-public-key");

        const response = await readPatient(app, await signPatientJwt(issuer.issuerUrl, issuer.keys.privateKey));

        expect(response.status).toBe(200);
        expect(issuer.requests.root).toBe(1);
        expect(issuer.requests.jwks).toBe(0);
    });

    it("auto — uses the standard jwks path when the IdP publishes jwks_uri", async () => {
        const issuer = await startIssuer({ serveJwks: true });
        const upstream = await startUpstream();
        const app = await startGateway(issuer, upstream, "auto");

        const jwt = await signPatientJwt(issuer.issuerUrl, issuer.keys.privateKey, TEST_JWK_KID);
        const response = await readPatient(app, jwt);

        expect(response.status).toBe(200);
        expect(issuer.requests.jwks).toBe(1);
        expect(issuer.requests.root).toBe(0);
    });

    it("auto — falls back to the Keycloak adapter when the IdP publishes only public_key", async () => {
        const issuer = await startIssuer({ serveJwks: false, publishJwksUri: false });
        const upstream = await startUpstream();
        const app = await startGateway(issuer, upstream, "auto");

        const response = await readPatient(app, await signPatientJwt(issuer.issuerUrl, issuer.keys.privateKey));

        expect(response.status).toBe(200);
        expect(issuer.requests.root).toBe(1);
        expect(issuer.requests.jwks).toBe(0);
    });

    it("auto — falls back to the Keycloak adapter when the published jwks_uri cannot be fetched", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const issuer = await startIssuer({ servePublicKey: true, serveJwks: false });
        const upstream = await startUpstream();
        const app = await startGateway(issuer, upstream, "auto");

        const response = await readPatient(app, await signPatientJwt(issuer.issuerUrl, issuer.keys.privateKey));

        expect(response.status).toBe(200);
        expect(issuer.requests.root).toBe(1);
    });

    it.each(["jwks", "keycloak-public-key", "auto"] as const)(
        "%s — rejects a token signed by the wrong key with 401",
        async (signingKeySource) => {
            const servesJwks = signingKeySource !== "keycloak-public-key";
            const issuer = await startIssuer({ serveJwks: servesJwks, publishJwksUri: servesJwks });
            const upstream = await startUpstream();
            const app = await startGateway(issuer, upstream, signingKeySource);
            const attacker = await generateKeyPair("RS256", { extractable: true });
            const forgedJwt = await signPatientJwt(issuer.issuerUrl, attacker.privateKey, TEST_JWK_KID);

            const response = await readPatient(app, forgedJwt);

            expect(response.status).toBe(401);
        },
    );

    it("jwks — fails at startup naming the setting when the discovery document has no jwks_uri", async () => {
        const issuer = await startIssuer({ servePublicKey: true, serveJwks: false, publishJwksUri: false });
        const upstream = await startUpstream();

        await expect(startGateway(issuer, upstream, "jwks")).rejects.toThrow(ENV_KEYS.SIGNING_KEY_SOURCE);
        expect(issuer.requests.root).toBe(0);
    });

    it("keycloak-public-key — fails at startup naming the setting when public_key is absent", async () => {
        const issuer = await startIssuer({ servePublicKey: false, publishJwksUri: false });
        const upstream = await startUpstream();

        await expect(startGateway(issuer, upstream, "keycloak-public-key")).rejects.toThrow(
            ENV_KEYS.SIGNING_KEY_SOURCE,
        );
    });

    it("fetches the issuer discovery document once at startup", async () => {
        const issuer = await startIssuer({ serveJwks: true });
        const upstream = await startUpstream();
        const app = await startGateway(issuer, upstream, "jwks");

        const jwt = await signPatientJwt(issuer.issuerUrl, issuer.keys.privateKey, TEST_JWK_KID);
        const proxyResponse = await readPatient(app, jwt);

        expect(proxyResponse.status).toBe(200);
        // 同一份 discovery 文件同時供金鑰解析與 .well-known/smart-configuration 代理使用
        expect(issuer.requests.wellKnown).toBe(1);
        expect(issuer.requests.root).toBe(0);
    });

    it("retries then fails at startup naming TOKEN_ISSUER with the cause when the IdP is unreachable", async () => {
        vi.useFakeTimers();
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const fetchFn = vi.fn<HttpFetchFn>().mockRejectedValue(new Error("connect ECONNREFUSED"));

        const promise = TokenVerifierService.create(
            verifierConfig(
                { issuerUrl: "http://127.0.0.1:1/realms/smart", wellKnownPath: "test" },
                "jwks",
            ),
            new HttpUtil(fetchFn),
        );
        const assertion = expect(promise).rejects.toSatisfy((error: unknown) => {
            expect(error).toBeInstanceOf(StartupConnectionError);
            expect(error).toMatchObject({ envKey: ENV_KEYS.TOKEN_ISSUER, attempts: 4 });
            return true;
        });
        const messageAssertion = expect(promise).rejects.toThrow(/'TOKEN_ISSUER'[\s\S]*connect ECONNREFUSED/);

        await vi.advanceTimersByTimeAsync(3000);
        await vi.advanceTimersByTimeAsync(6000);
        await vi.advanceTimersByTimeAsync(9000);
        await assertion;
        await messageAssertion;

        expect(fetchFn).toHaveBeenCalledTimes(4);
    });

    it("uses the signing key resolver injected at app construction", async () => {
        const issuer = await startIssuer({ serveJwks: true });
        const upstream = await startUpstream();
        const attacker = await generateKeyPair("RS256", { extractable: true });
        const foreignKey = await importJWK(await exportJWK(attacker.publicKey), "RS256");
        const injectedResolver: SigningKeyResolver = {
            resolveVerificationKey: async () => foreignKey,
        };
        const injectedSigningKeys: ResolvedSigningKeys = {
            resolver: injectedResolver,
            discoveryDocument: issuer.wellKnownConfig,
        };

        const tokenVerifier = await TokenVerifierService.create(
            verifierConfig(issuer, "jwks"),
            undefined,
            injectedSigningKeys,
        );
        const app = createApp({ tokenVerifier, config: gatewayConfig(issuer, upstream) });
        const jwt = await signPatientJwt(issuer.issuerUrl, issuer.keys.privateKey, TEST_JWK_KID);

        // IdP 公布的 JWKS 可正常驗簽，但 app 改用注入的 resolver 後同一 token 必須被拒
        const response = await readPatient(app, jwt);

        expect(response.status).toBe(401);
        expect(issuer.requests.jwks).toBe(0);
    });
});

describe("signing key rotation", () => {
    const closers: Array<() => Promise<void>> = [];

    async function startIssuer(options: IssuerTestServerOptions): Promise<IssuerTestServer> {
        const issuer = await startIssuerTestServer("test", options);
        closers.push(() => issuer.close());
        return issuer;
    }

    async function startUpstream(): Promise<UpstreamServer> {
        const upstream = await startUpstreamServer();
        closers.push(() => upstream.close());
        return upstream;
    }

    afterEach(async () => {
        vi.restoreAllMocks();
        await Promise.all(closers.splice(0).map((close) => close()));
    });

    it("jwks — authorizes a token signed by a key the IdP published only after startup", async () => {
        const issuer = await startIssuer({ servePublicKey: false, serveJwks: true });
        const upstream = await startUpstream();
        const app = await startGateway(issuer, upstream, "jwks");

        const before = await readPatient(
            app,
            await signPatientJwt(issuer.issuerUrl, issuer.keys.privateKey, TEST_JWK_KID),
        );
        expect(before.status).toBe(200);

        // IdP 輪替簽章金鑰；同一個 app instance（未重新啟動）必須認得新 kid
        const rotated = await issuer.rotateSigningKey();
        const after = await readPatient(app, await signPatientJwt(issuer.issuerUrl, rotated.privateKey, rotated.kid));

        expect(after.status).toBe(200);
        expect(issuer.requests.jwks).toBe(2);
    });

    it("jwks — authorizes concurrent tokens carrying the same rotated kid", async () => {
        const issuer = await startIssuer({ servePublicKey: false, serveJwks: true });
        const upstream = await startUpstream();
        const app = await startGateway(issuer, upstream, "jwks");

        const rotated = await issuer.rotateSigningKey();
        const jwt = await signPatientJwt(issuer.issuerUrl, rotated.privateKey, rotated.kid);

        // 同時抵達的請求必須共用同一個重新抓取，不能各自拿著舊快照回 401
        const responses = await Promise.all([readPatient(app, jwt), readPatient(app, jwt), readPatient(app, jwt)]);

        expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
        expect(issuer.requests.jwks).toBe(2);
    });

    it("jwks — rejects a token naming a kid the IdP never publishes", async () => {
        const issuer = await startIssuer({ servePublicKey: false, serveJwks: true });
        const upstream = await startUpstream();
        const app = await startGateway(issuer, upstream, "jwks");

        const response = await readPatient(
            app,
            await signPatientJwt(issuer.issuerUrl, issuer.keys.privateKey, "kid-the-idp-never-had"),
        );

        expect(response.status).toBe(401);
    });

    it("jwks — re-fetches the JWKS at most once per unrecognised kid", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const issuer = await startIssuer({ servePublicKey: false, serveJwks: true });
        const upstream = await startUpstream();
        const app = await startGateway(issuer, upstream, "jwks");
        const jwt = await signPatientJwt(issuer.issuerUrl, issuer.keys.privateKey, "unknown-kid");

        const first = await readPatient(app, jwt);
        const jwksAfterFirst = issuer.requests.jwks;
        const second = await readPatient(app, jwt);

        expect(first.status).toBe(401);
        expect(second.status).toBe(401);
        // 啟動 1 次 + 第一次遇到未知 kid 重新抓 1 次；同一個 kid 不再重複抓
        expect(jwksAfterFirst).toBe(2);
        expect(issuer.requests.jwks).toBe(2);
    });

    it("jwks — returns 401 when the IdP is unreachable during a key refresh", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const issuer = await startIssuer({ servePublicKey: false, serveJwks: true });
        const upstream = await startUpstream();
        const app = await startGateway(issuer, upstream, "jwks");
        issuer.setJwksAvailability("unreachable");

        const rotated = await issuer.rotateSigningKey();
        const response = await readPatient(app, await signPatientJwt(issuer.issuerUrl, rotated.privateKey, rotated.kid));

        expect(response.status).toBe(401);
    });

    it("keycloak-public-key — does not pick up a rotated key", async () => {
        const issuer = await startIssuer({ serveJwks: false, publishJwksUri: false });
        const upstream = await startUpstream();
        const app = await startGateway(issuer, upstream, "keycloak-public-key");

        const rotated = await issuer.rotateSigningKey();
        const response = await readPatient(app, await signPatientJwt(issuer.issuerUrl, rotated.privateKey, rotated.kid));

        expect(response.status).toBe(401);
        // legacy adapter 的金鑰在啟動時載入一次，不會因為輪替而重新抓
        expect(issuer.requests.root).toBe(1);
    });
});