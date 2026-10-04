import type { CryptoKey } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type App, createApp } from "../src/app";
import type { GatewayConfig } from "../src/configs/env.schema";
import { ENV_KEYS } from "../src/constants/config";
import { FHIR_API_PREFIX } from "../src/constants/routes";
import { INTERNAL_CREDENTIAL_HEADER } from "../src/controllers/internal-launch/internal-launch.controller";
import { StartupConnectionError } from "../src/errors/startup-connection.error";
import { AllowedQueriesCheckerService } from "../src/services/allowed-queries.service";
import { createLaunchContextStore } from "../src/services/launch-context-store-factory.service";
import { PatientFinderService } from "../src/services/patient-finder.service";
import { TokenVerifierService } from "../src/services/token-verifier.service";
import {
    createValkeyClient,
    LAUNCH_CONTEXT_KEY_PREFIX,
    ValkeyLaunchContextStore,
} from "../src/services/valkey-launch-context-store.service";
import { sleep } from "../src/utils/retry.util";
import { type IssuerTestServer, startIssuerTestServer } from "./helpers/issuer-test-server";
import {
    APP_CLIENT_ID,
    APP_REDIRECT_URI,
    AUTHORIZED_PATIENT,
    authenticateAtIdp,
    authorizeParams,
    CODE_VERIFIER,
    createBaseConfig,
    GATEWAY_IDP_CLIENT_ID,
    GATEWAY_IDP_CLIENT_SECRET,
    gatewayAuthorize,
    gatewayToken,
    INTERNAL_CREDENTIAL,
    locationOf,
    OTHER_APP_CLIENT_ID,
    OTHER_PATIENT,
    signAccessToken,
    startUpstreamServer,
    type UpstreamServer,
} from "./helpers/launch-flow-fixture";

/**
 * launch context 存在共享的 Valkey 時的行為，走整個 app over HTTP。
 *
 * 與 `store-backed-launch-context.test.ts` 的差別只有 store：in-memory 那組證明單一 process
 * 的裁決，這一組證明**綁定活得比 process 久**，而且看得見其他 instance 寫進去的綁定。
 * 因此它們必須真的連一個 Valkey——對 stub 跑只會證明 gateway 有呼叫那個 stub。
 *
 * 沒有 Valkey 時整組跳過（`pnpm run verify` 不依賴外部服務）。要跑這一組：
 * `docker run -d --name valkey -p 6379:6379 valkey/valkey:8-alpine`，
 * 或設 `LAUNCH_CONTEXT_VALKEY_URL` 指向既有的 Valkey。
 */

const VALKEY_URL = process.env.LAUNCH_CONTEXT_VALKEY_URL ?? "redis://127.0.0.1:6379";

/** 沒有服務在聽的 port；連線 URL 帶著憑證，用來檢查錯誤訊息不會把它印出來。 */
const UNREACHABLE_VALKEY_URL = "redis://gateway:super-secret-password@127.0.0.1:1";

const PATIENT_READ_SCOPE = "patient/Patient.read";

type GatewayInstance = { app: App; store: ValkeyLaunchContextStore };

async function valkeyIsReachable(): Promise<boolean> {
    const client = createValkeyClient(VALKEY_URL);
    try {
        await client.connect();
        await client.ping();
        return true;
    } catch {
        return false;
    } finally {
        client.destroy();
    }
}

const valkeyAvailable = await valkeyIsReachable();

/** 清掉上一次測試留下的綁定，讓每個案例都從乾淨的 store 開始。 */
async function clearLaunchContextKeys(): Promise<void> {
    if (!valkeyAvailable) {
        return;
    }
    const client = createValkeyClient(VALKEY_URL);
    await client.connect();
    try {
        // 這個 namespace 只有測試會寫，`KEYS` 在測試裡是可接受的。
        const keys = await client.keys(`${LAUNCH_CONTEXT_KEY_PREFIX}*`);
        if (keys.length > 0) {
            await client.del(keys);
        }
    } finally {
        await client.close();
    }
}

describe.skipIf(!valkeyAvailable)("launch context in a shared Valkey, over the app seam", () => {
    let issuer: IssuerTestServer;
    let upstream: UpstreamServer;
    let tokenVerifier: TokenVerifierService;
    let opened: ValkeyLaunchContextStore[];

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
        opened = [];
        await clearLaunchContextKeys();
    });

    afterEach(async () => {
        await issuer.close();
        await upstream.close();
        for (const store of opened) {
            await store.close();
        }
        await clearLaunchContextKeys();
    });

    const buildAppWith = (config: GatewayConfig, store: ValkeyLaunchContextStore): App => {
        opened.push(store);
        return createApp({
            tokenVerifier,
            config,
            allowedQueries: AllowedQueriesCheckerService.loadFromFile(config.allowedQueriesFile),
            patientFinder: PatientFinderService.getInstance(),
            launchContextStore: store,
        });
    };

    const configFor = (overrides: Partial<GatewayConfig> = {}): GatewayConfig =>
        createBaseConfig({
            tokenIssuer: issuer.issuerUrl,
            proxyTo: upstream.baseUrl,
            allowedQueriesFile: undefined,
            ...overrides,
        });

    /**
     * 一個 gateway instance：自己的 app、自己一條 Valkey 連線、一份空的記憶體狀態。
     * 兩個 instance 能互相看見綁定，唯一的原因就是它們共用同一個 store。
     */
    const buildInstance = async (overrides: Partial<GatewayConfig> = {}): Promise<GatewayInstance> => {
        const config = configFor({ launchContextValkeyUrl: VALKEY_URL, ...overrides });
        const client = createValkeyClient(VALKEY_URL);
        await client.connect();
        const store = new ValkeyLaunchContextStore(client);
        return { app: buildAppWith(config, store), store };
    };

    /** 一個連得上、但連線已被切斷的 store：Valkey 對這個 process 就是不可達的。 */
    const buildInstanceWithBrokenValkey = async (overrides: Partial<GatewayConfig> = {}): Promise<App> => {
        const client = createValkeyClient(VALKEY_URL);
        await client.connect();
        // 真實的連線中斷：Valkey 還在跑，但這個 store 的連線已經沒了。
        client.destroy();
        return buildAppWith(configFor(overrides), new ValkeyLaunchContextStore(client));
    };

    const registerLaunchContext = async (app: App, body: Record<string, string>): Promise<string> => {
        const response = await app.handle(
            new Request("http://localhost/internal/launch-contexts", {
                method: "POST",
                headers: { "content-type": "application/json", [INTERNAL_CREDENTIAL_HEADER]: INTERNAL_CREDENTIAL },
                body: JSON.stringify(body),
            }),
        );
        expect(response.status).toBe(201);
        const created = (await response.json()) as { launchId: string };
        return created.launchId;
    };

    type IssuedTokens = { access_token: string; refresh_token: string };

    /** 跑完整條瀏覽器路徑並換出 token；綁定因此由 gateway 自己寫進 store。 */
    const launch = async (
        app: App,
        body: Record<string, string>,
        clientId: string = APP_CLIENT_ID,
    ): Promise<IssuedTokens> => {
        const launchId = await registerLaunchContext(app, body);
        const idpRedirect = await locationOf(
            await app.handle(gatewayAuthorize(authorizeParams(launchId, { client_id: clientId }))),
        );
        const gatewayCallback = await authenticateAtIdp(idpRedirect);
        const appRedirect = await locationOf(await app.handle(new Request(gatewayCallback, { redirect: "manual" })));

        const tokenResponse = await app.handle(
            gatewayToken({
                grant_type: "authorization_code",
                code: appRedirect.searchParams.get("code") ?? "",
                redirect_uri: APP_REDIRECT_URI,
                client_id: clientId,
                code_verifier: CODE_VERIFIER,
            }),
        );
        expect(tokenResponse.status).toBe(200);
        return (await tokenResponse.json()) as IssuedTokens;
    };

    const refresh = async (app: App, refreshToken: string, clientId: string = APP_CLIENT_ID): Promise<string> => {
        const response = await app.handle(
            gatewayToken({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
        );
        expect(response.status).toBe(200);
        const refreshed = (await response.json()) as { access_token: string };
        return refreshed.access_token;
    };

    /** 自己簽一張 IdP access token；token 裡沒有病人，綁定只能從 store 來。 */
    const tokenWithoutBinding = async (): Promise<string> =>
        await signAccessToken(issuer.issuerUrl, issuer.keys.privateKey as CryptoKey, {
            jti: "token-with-no-binding",
            scope: PATIENT_READ_SCOPE,
        });

    const fhirGet = (app: App, path: string, accessToken: string): Promise<Response> =>
        app.handle(
            new Request(`https://gateway.example${FHIR_API_PREFIX}${path}`, {
                headers: { Authorization: `Bearer ${accessToken}` },
            }),
        );

    it("authorizes to the same patient after the gateway restarts", async () => {
        const before = await buildInstance();
        const { access_token: accessToken } = await launch(before.app, { patientId: AUTHORIZED_PATIENT });

        // 重啟：一個全新的 instance，記憶體裡什麼都沒有，只剩共享的 Valkey。
        const after = await buildInstance();

        expect((await fhirGet(after.app, `/Patient/${AUTHORIZED_PATIENT}`, accessToken)).status).toBe(200);
        expect((await fhirGet(after.app, `/Patient/${OTHER_PATIENT}`, accessToken)).status).toBe(403);
    });

    it("resolves on every instance the binding each of them wrote, per client id", async () => {
        const first = await buildInstance();
        const second = await buildInstance();

        const firstToken = await launch(first.app, { patientId: AUTHORIZED_PATIENT }, APP_CLIENT_ID);
        const secondToken = await launch(second.app, { patientId: OTHER_PATIENT }, OTHER_APP_CLIENT_ID);

        // 同一個 clinician、同一個 IdP、兩個 App：綁分別寫在兩個 instance 上，
        // 兩個 instance 都要靠 `(subject, client id)` 索引各自解析到自己的病人。
        for (const instance of [first.app, second.app]) {
            expect((await fhirGet(instance, `/Patient/${AUTHORIZED_PATIENT}`, firstToken.access_token)).status).toBe(
                200,
            );
            expect((await fhirGet(instance, `/Patient/${OTHER_PATIENT}`, firstToken.access_token)).status).toBe(403);
            expect((await fhirGet(instance, `/Patient/${OTHER_PATIENT}`, secondToken.access_token)).status).toBe(200);
            expect((await fhirGet(instance, `/Patient/${AUTHORIZED_PATIENT}`, secondToken.access_token)).status).toBe(
                403,
            );
        }
    });

    it("keeps resolving the launch context after the app refreshes its token", async () => {
        const before = await buildInstance();
        const { refresh_token: refreshToken } = await launch(before.app, { patientId: AUTHORIZED_PATIENT });
        const refreshed = await refresh(before.app, refreshToken);

        const after = await buildInstance();

        expect((await fhirGet(after.app, `/Patient/${AUTHORIZED_PATIENT}`, refreshed)).status).toBe(200);
        expect((await fhirGet(after.app, `/Patient/${OTHER_PATIENT}`, refreshed)).status).toBe(403);
    });

    it("refuses a patient-mode request while the shared Valkey is unreachable", async () => {
        const app = await buildInstanceWithBrokenValkey();

        expect((await fhirGet(app, `/Patient/${AUTHORIZED_PATIENT}`, await tokenWithoutBinding())).status).toBe(401);
    });

    it("refuses a list-mode request while the shared Valkey is unreachable", async () => {
        const app = await buildInstanceWithBrokenValkey({ accessChecker: "list" });

        expect((await fhirGet(app, `/Patient/${AUTHORIZED_PATIENT}`, await tokenWithoutBinding())).status).toBe(401);
    });

    it("keeps serving a mode that needs no launch context while the shared Valkey is unreachable", async () => {
        const app = await buildInstanceWithBrokenValkey({ accessChecker: "basic" });

        expect((await fhirGet(app, `/Patient/${AUTHORIZED_PATIENT}`, await tokenWithoutBinding())).status).toBe(200);
    });

    it("stops resolving a launch context once its binding is deleted", async () => {
        const instance = await buildInstance();
        const { access_token: accessToken } = await launch(instance.app, { patientId: AUTHORIZED_PATIENT });
        expect((await fhirGet(instance.app, `/Patient/${AUTHORIZED_PATIENT}`, accessToken)).status).toBe(200);

        expect(await instance.store.delete("clinician-42", APP_CLIENT_ID)).toBe(true);

        // 綁定消失時，一併指向它的 access token 也必須查不到，而不是繼續授權到最後。
        expect((await fhirGet(instance.app, `/Patient/${AUTHORIZED_PATIENT}`, accessToken)).status).toBe(401);
        expect(await instance.store.delete("clinician-42", APP_CLIENT_ID)).toBe(false);
    });

    it("leaves nothing bindable in Valkey once the unbound launch context expires", async () => {
        const instance = await buildInstance({ launchContextTtlSeconds: 1 });
        const launchId = await registerLaunchContext(instance.app, { patientId: AUTHORIZED_PATIENT });
        expect(await instance.store.isAvailable(launchId)).toBe(true);

        // 這裡等的是 Valkey 自己的 TTL：替身時鐘不會讓真實的 store 到期。
        await sleep(1500);

        expect(await instance.store.isAvailable(launchId)).toBe(false);
        expect((await instance.app.handle(gatewayAuthorize(authorizeParams(launchId)))).status).toBe(400);

        // 換一個 instance（新的連線）也一樣：過期的未綁定 context 真的從 Valkey 消失了。
        const other = await buildInstance();
        expect(await other.store.isAvailable(launchId)).toBe(false);
    });
});

describe("launch context store selection at startup", () => {
    it("fails naming the environment variable when the selected Valkey cannot be reached", async () => {
        const config = createBaseConfig({
            launchContextStoreType: "valkey",
            launchContextValkeyUrl: UNREACHABLE_VALKEY_URL,
        });

        await expect(createLaunchContextStore(config, { retryDelaysMs: [] })).rejects.toSatisfy((error: unknown) => {
            expect(error).toBeInstanceOf(StartupConnectionError);
            expect((error as StartupConnectionError).envKey).toBe(ENV_KEYS.LAUNCH_CONTEXT_VALKEY_URL);
            // 連線 URL 帶著認證憑證，錯誤訊息不得把它印出來。
            expect((error as StartupConnectionError).url).not.toContain("super-secret-password");
            return true;
        });
    });

    it("marks the in-memory store as unsuitable for production", async () => {
        const warnings: string[] = [];
        const warn = console.warn;
        console.warn = (message?: unknown) => {
            warnings.push(String(message));
        };
        try {
            await createLaunchContextStore(createBaseConfig({ launchContextStoreType: "memory", runMode: "PROD" }));
        } finally {
            console.warn = warn;
        }

        expect(warnings.join("\n")).toContain(ENV_KEYS.LAUNCH_CONTEXT_STORE);
    });
});
