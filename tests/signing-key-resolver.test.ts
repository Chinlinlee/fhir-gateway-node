import { createServer, type Server } from "node:http";

import { type CryptoKey, exportJWK, generateKeyPair, importJWK, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type App, createApp } from "../src/app";
import type { GatewayConfig } from "../src/configs/env.schema";
import { ENV_KEYS, type SigningKeySource } from "../src/constants/config";
import { FHIR_API_PREFIX, WELL_KNOWN_SMART_CONFIGURATION_PATH } from "../src/constants/routes";
import { StartupConnectionError } from "../src/errors/startup-connection.error";
import { PATIENT_CLAIM } from "../src/services/access-checkers/patient-access-checker.service";
import type { ResolvedSigningKeys, SigningKeyResolver } from "../src/services/signing-keys/signing-key-resolver";
import { TokenVerifierService } from "../src/services/token-verifier.service";
import type { HttpFetchFn } from "../src/utils/http.util";
import { HttpUtil } from "../src/utils/http.util";
import {
    type IssuerTestServer,
    type IssuerTestServerOptions,
    startIssuerTestServer,
    TEST_JWK_KID,
    TEST_JWKS_PATH,
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

function verifierConfig(issuer: { issuerUrl: string; wellKnownPath: string }, signingKeySource?: SigningKeySource) {
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
        // publishJwksUri=true + serveJwks=false：宣告了 jwks_uri 但端點回 404
        const issuer = await startIssuer({ servePublicKey: true, serveJwks: false });
        const upstream = await startUpstream();
        const app = await startGateway(issuer, upstream, "auto");

        const response = await readPatient(app, await signPatientJwt(issuer.issuerUrl, issuer.keys.privateKey));

        expect(response.status).toBe(200);
        // auto 必須真的先探過 jwks_uri 才回退；刪掉 auto 探測區塊這個計數就會是 0
        expect(issuer.requests.jwks).toBeGreaterThanOrEqual(1);
        expect(issuer.requests.root).toBe(1);
    });

    it("auto — authorizes a token carrying no kid when the IdP publishes exactly one JWKS key", async () => {
        const issuer = await startIssuer({ servePublicKey: false, serveJwks: true, jwksKeyCount: 1 });
        const upstream = await startUpstream();
        const app = await startGateway(issuer, upstream, "auto");

        // legacy Keycloak adapter 完全忽略 kid；標準路徑必須保留同樣的單金鑰容忍
        const response = await readPatient(app, await signPatientJwt(issuer.issuerUrl, issuer.keys.privateKey));

        expect(response.status).toBe(200);
        expect(issuer.requests.jwks).toBe(1);
        expect(issuer.requests.root).toBe(0);
    });

    it("auto — refuses a token carrying no kid when the IdP publishes several JWKS keys", async () => {
        const issuer = await startIssuer({ servePublicKey: false, serveJwks: true, jwksKeyCount: 3 });
        const upstream = await startUpstream();
        const app = await startGateway(issuer, upstream, "auto");

        const response = await readPatient(app, await signPatientJwt(issuer.issuerUrl, issuer.keys.privateKey));

        expect(response.status).toBe(401);
        const body = (await response.json()) as { issue?: Array<{ diagnostics?: string }> };
        expect(body.issue?.[0]?.diagnostics).toContain("no 'kid'");
    });

    it("jwks — authorizes a token carrying a published kid when the IdP publishes several keys", async () => {
        const issuer = await startIssuer({ servePublicKey: false, serveJwks: true, jwksKeyCount: 3 });
        const upstream = await startUpstream();
        const app = await startGateway(issuer, upstream, "jwks");

        const response = await readPatient(
            app,
            await signPatientJwt(issuer.issuerUrl, issuer.keys.privateKey, TEST_JWK_KID),
        );

        expect(response.status).toBe(200);
    });

    it.each([
        "jwks",
        "keycloak-public-key",
        "auto",
    ] as const)("%s — rejects a token signed by the wrong key with 401", async (signingKeySource) => {
        const servesJwks = signingKeySource !== "keycloak-public-key";
        const issuer = await startIssuer({ serveJwks: servesJwks, publishJwksUri: servesJwks });
        const upstream = await startUpstream();
        const app = await startGateway(issuer, upstream, signingKeySource);
        const attacker = await generateKeyPair("RS256", { extractable: true });
        const forgedJwt = await signPatientJwt(issuer.issuerUrl, attacker.privateKey, TEST_JWK_KID);

        const response = await readPatient(app, forgedJwt);

        expect(response.status).toBe(401);
    });

    it("jwks — fails at startup naming the setting when the discovery document has no jwks_uri", async () => {
        const issuer = await startIssuer({ servePublicKey: true, serveJwks: false, publishJwksUri: false });
        const upstream = await startUpstream();

        // 兩條分支的錯誤訊息都含 SIGNING_KEY_SOURCE，靠指名缺什麼才能分辨走錯分支
        await expect(startGateway(issuer, upstream, "jwks")).rejects.toThrow(/jwks_uri/);
        // 只讀 discovery document；絕不為了驗簽去 GET issuer root URL
        expect(issuer.requests.wellKnown).toBe(1);
        expect(issuer.requests.root).toBe(0);
        expect(issuer.requests.jwks).toBe(0);
    });

    it("keycloak-public-key — fails at startup naming the setting when public_key is absent", async () => {
        const issuer = await startIssuer({ servePublicKey: false, publishJwksUri: false });
        const upstream = await startUpstream();

        await expect(startGateway(issuer, upstream, "keycloak-public-key")).rejects.toThrow(/public_key/);
        // 明確選擇 legacy 路徑就必須真的去讀 issuer root URL
        expect(issuer.requests.root).toBe(1);
        expect(issuer.requests.jwks).toBe(0);
    });

    it("jwks — fails at startup naming SIGNING_KEY_SOURCE when the published jwks_uri is unreachable", async () => {
        const discoveryDocument = JSON.stringify({
            issuer: "https://idp.example/realms/smart",
            jwks_uri: "https://idp.example/realms/smart/protocol/openid-connect/certs",
        });
        // 只答 discovery document；JWKS 端點一律連不上，啟動重試與錯誤包裝都走真實邏輯
        const requestedUrls: string[] = [];
        const httpUtil = new (class extends HttpUtil {
            override async getText(url: string): Promise<string> {
                requestedUrls.push(url);
                if (url.endsWith("openid-configuration")) {
                    return discoveryDocument;
                }
                throw new Error("connect ECONNREFUSED");
            }
        })();
        vi.useFakeTimers();
        vi.spyOn(console, "warn").mockImplementation(() => {});

        const promise = TokenVerifierService.create(
            verifierConfig(
                { issuerUrl: "https://idp.example/realms/smart", wellKnownPath: ".well-known/openid-configuration" },
                "jwks",
            ),
            httpUtil,
        );
        const assertion = expect(promise).rejects.toSatisfy((error: unknown) => {
            expect(error).toBeInstanceOf(StartupConnectionError);
            expect(error).toMatchObject({ envKey: ENV_KEYS.SIGNING_KEY_SOURCE, attempts: 4 });
            return true;
        });
        const messageAssertion = expect(promise).rejects.toThrow(/'SIGNING_KEY_SOURCE'[\s\S]*connect ECONNREFUSED/);

        await vi.advanceTimersByTimeAsync(3000);
        await vi.advanceTimersByTimeAsync(6000);
        await vi.advanceTimersByTimeAsync(9000);
        await assertion;
        await messageAssertion;

        // discovery document 成功 1 次，之後 4 次都打在 JWKS 端點上
        expect(requestedUrls.filter((url) => url.includes(TEST_JWKS_PATH))).toHaveLength(4);
    });

    it("fetches the issuer discovery document once at startup", async () => {
        const issuer = await startIssuer({ serveJwks: true });
        const upstream = await startUpstream();
        const app = await startGateway(issuer, upstream, "jwks");

        const jwt = await signPatientJwt(issuer.issuerUrl, issuer.keys.privateKey, TEST_JWK_KID);
        const proxyResponse = await readPatient(app, jwt);
        const wellKnownResponse = await app.handle(
            new Request(`http://localhost${FHIR_API_PREFIX}/${WELL_KNOWN_SMART_CONFIGURATION_PATH}`),
        );

        expect(proxyResponse.status).toBe(200);
        expect(wellKnownResponse.status).toBe(200);
        expect(await wellKnownResponse.json()).toEqual(JSON.parse(issuer.wellKnownConfig));
        // 同一份 discovery 文件同時供金鑰解析與 .well-known/smart-configuration 代理使用
        expect(issuer.requests.wellKnown).toBe(1);
        expect(issuer.requests.root).toBe(0);
    });

    it("retries then fails at startup naming TOKEN_ISSUER with the cause when the IdP is unreachable", async () => {
        vi.useFakeTimers();
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const fetchFn = vi.fn<HttpFetchFn>().mockRejectedValue(new Error("connect ECONNREFUSED"));

        const promise = TokenVerifierService.create(
            verifierConfig({ issuerUrl: "http://127.0.0.1:1/realms/smart", wellKnownPath: "test" }, "jwks"),
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
        vi.useRealTimers();
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

    it("jwks — returns 401 naming the unmatched kid when the IdP is unreachable during a key refresh", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const issuer = await startIssuer({ servePublicKey: false, serveJwks: true });
        const upstream = await startUpstream();
        const app = await startGateway(issuer, upstream, "jwks");
        issuer.setJwksAvailability("unreachable");

        const rotated = await issuer.rotateSigningKey();
        const response = await readPatient(
            app,
            await signPatientJwt(issuer.issuerUrl, rotated.privateKey, rotated.kid),
        );

        expect(response.status).toBe(401);
        // 重新抓取失敗必須被 refreshKeySet 吃掉並保留舊快照，因此診斷是「kid 對不上」
        // 而不是連線錯誤；刪掉那段 try/catch 會變成 fetch 的連線錯誤訊息。
        const body = (await response.json()) as { issue?: Array<{ diagnostics?: string }> };
        expect(body.issue?.[0]?.diagnostics).toContain(`matches kid '${rotated.kid}'`);
    });

    it("jwks — caps how much JWKS traffic many distinct unknown kids can cause", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const issuer = await startIssuer({ servePublicKey: false, serveJwks: true });
        const upstream = await startUpstream();
        const app = await startGateway(issuer, upstream, "jwks");

        // `jose` 以未驗證的 protected header 選金鑰，所以這些 token 攻擊者自己就能簽
        const unknownKids = Array.from({ length: 40 }, (_unused, index) => `attacker-kid-${index}`);
        const burstStatuses: number[] = [];
        for (const kid of unknownKids) {
            const response = await readPatient(
                app,
                await signPatientJwt(issuer.issuerUrl, issuer.keys.privateKey, kid),
            );
            burstStatuses.push(response.status);
        }
        const jwksAfterBurst = issuer.requests.jwks;

        // 沒有上限時這裡會是 1（啟動）+ 40（每個未知 kid 一次）
        expect(burstStatuses).toEqual(unknownKids.map(() => 401));
        expect(jwksAfterBurst).toBeLessThanOrEqual(6);

        const secondBurst: number[] = [];
        for (const kid of unknownKids) {
            const response = await readPatient(
                app,
                await signPatientJwt(issuer.issuerUrl, issuer.keys.privateKey, kid),
            );
            secondBurst.push(response.status);
        }

        // 預算用盡後完全不再對外抓取，而不是每個 kid 再抓一次
        expect(secondBurst).toEqual(unknownKids.map(() => 401));
        expect(issuer.requests.jwks).toBe(jwksAfterBurst);
    });

    it("jwks — resumes unknown-kid refreshes once the refresh budget window has passed", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const issuer = await startIssuer({ servePublicKey: false, serveJwks: true });
        const upstream = await startUpstream();
        const app = await startGateway(issuer, upstream, "jwks");
        vi.useFakeTimers({ toFake: ["Date"] });

        const rotated = await issuer.rotateSigningKey();
        const jwt = await signPatientJwt(issuer.issuerUrl, rotated.privateKey, rotated.kid);
        expect((await readPatient(app, jwt)).status).toBe(200);
        const jwksAfterRotation = issuer.requests.jwks;

        for (let index = 0; index < 10; index += 1) {
            expect(
                (await readPatient(app, await signPatientJwt(issuer.issuerUrl, issuer.keys.privateKey, `kid-${index}`)))
                    .status,
            ).toBe(401);
        }
        const jwksAfterExhaustion = issuer.requests.jwks;

        vi.setSystemTime(Date.now() + 61_000);
        const rotatedAgain = await issuer.rotateSigningKey();

        // 預算只是速率上限，不是永久拒絕：時間窗過去後真正的輪替仍要能通過
        expect(
            (await readPatient(app, await signPatientJwt(issuer.issuerUrl, rotatedAgain.privateKey, rotatedAgain.kid)))
                .status,
        ).toBe(200);
        expect(issuer.requests.jwks).toBeGreaterThan(jwksAfterExhaustion);
        expect(jwksAfterExhaustion).toBeLessThanOrEqual(jwksAfterRotation + 5);
    });

    it("keycloak-public-key — does not pick up a rotated key", async () => {
        const issuer = await startIssuer({ serveJwks: false, publishJwksUri: false });
        const upstream = await startUpstream();
        const app = await startGateway(issuer, upstream, "keycloak-public-key");

        const rotated = await issuer.rotateSigningKey();
        const response = await readPatient(
            app,
            await signPatientJwt(issuer.issuerUrl, rotated.privateKey, rotated.kid),
        );

        expect(response.status).toBe(401);
        // legacy adapter 的金鑰在啟動時載入一次，不會因為輪替而重新抓
        expect(issuer.requests.root).toBe(1);
    });
});
