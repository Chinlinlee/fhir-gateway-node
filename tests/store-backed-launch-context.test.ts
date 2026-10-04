import { type CryptoKey, decodeJwt, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type App, createApp } from "../src/app";
import type { GatewayConfig } from "../src/configs/env.schema";
import { FHIR_API_PREFIX } from "../src/constants/routes";
import { INTERNAL_CREDENTIAL_HEADER } from "../src/controllers/internal-launch/internal-launch.controller";
import { AllowedQueriesCheckerService } from "../src/services/allowed-queries.service";
import { InMemoryLaunchContextStore } from "../src/services/launch-context-store.service";
import { PatientFinderService } from "../src/services/patient-finder.service";
import { TokenVerifierService } from "../src/services/token-verifier.service";
import type { LaunchContextStore } from "../src/types/launch-context-store";
import { type IssuerTestServer, startIssuerTestServer } from "./helpers/issuer-test-server";
import { seedLaunchContextForToken, unreachableLaunchContextStore } from "./helpers/launch-context-fixture";
import {
    APP_CLIENT_ID,
    APP_REDIRECT_URI,
    AUTHORIZED_PATIENT,
    authenticateAtIdp,
    authorizeParams,
    CODE_VERIFIER,
    createBaseConfig,
    GATEWAY_BASE_URL,
    GATEWAY_IDP_CLIENT_ID,
    GATEWAY_IDP_CLIENT_SECRET,
    gatewayAuthorize,
    gatewayToken,
    INTERNAL_CREDENTIAL,
    locationOf,
    OTHER_APP_CLIENT_ID,
    OTHER_PATIENT,
    PATIENT_LIST_ID,
    startUpstreamServer,
    type UpstreamServer,
} from "./helpers/launch-flow-fixture";

/**
 * launch context 改由 gateway 持有之後，access token 不再帶任何病人資訊。
 * 這些測試走整個 app over HTTP，並且走完整的 SMART 授權流程，讓綁定真的由 gateway 寫進
 * store——測試不會自己塞一份 DTO 進去。
 *
 * 這裡的 store 是 in-memory 的；同一條路徑對真實 Valkey 的驗證在
 * `valkey-launch-context-store.test.ts`。
 */

describe("launch context owned by the gateway, over the app seam", () => {
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

    const buildApp = (overrides: Partial<GatewayConfig> = {}, launchContextStore: LaunchContextStore = store) => {
        const config = createBaseConfig({
            tokenIssuer: issuer.issuerUrl,
            proxyTo: upstream.baseUrl,
            allowedQueriesFile: undefined,
            ...overrides,
        });
        return createApp({
            tokenVerifier,
            config,
            allowedQueries: AllowedQueriesCheckerService.loadFromFile(config.allowedQueriesFile),
            patientFinder: PatientFinderService.getInstance(),
            launchContextStore,
        });
    };

    /** EHR 在 App 開啟前建立 launch context；回傳 gateway 生成的 launch id。 */
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

    /** 跑完整條瀏覽器路徑並換出 access token；回傳 gateway 自己 token endpoint 發的那組 token。 */
    const launch = async (
        app: App,
        body: Record<string, string>,
        clientId: string,
        overrides: Record<string, string> = {},
    ): Promise<{ accessToken: string; refreshToken: string }> => {
        const launchId = await registerLaunchContext(app, body);
        const idpRedirect = await locationOf(
            await app.handle(gatewayAuthorize(authorizeParams(launchId, { client_id: clientId, ...overrides }))),
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
        const tokens = (await tokenResponse.json()) as { access_token: string; refresh_token: string };
        return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token };
    };

    const fhirGet = (app: App, path: string, accessToken: string): Promise<Response> =>
        app.handle(
            new Request(`${GATEWAY_BASE_URL}${FHIR_API_PREFIX}${path}`, {
                headers: { Authorization: `Bearer ${accessToken}` },
            }),
        );

    /** 自己簽一張 IdP access token；用來測試「不經代理流程」的請求路徑。 */
    const signAccessToken = async (claims: Record<string, string>): Promise<string> =>
        await new SignJWT(claims)
            .setProtectedHeader({ alg: "RS256" })
            .setIssuer(issuer.issuerUrl)
            .setSubject("clinician-42")
            .sign(issuer.keys.privateKey as CryptoKey);

    it("authorizes to the launch context the gateway recorded, with no patient in the access token", async () => {
        const app = buildApp();
        const { accessToken } = await launch(app, { patientId: AUTHORIZED_PATIENT }, APP_CLIENT_ID);

        expect(decodeJwt(accessToken).patient).toBeUndefined();
        expect(decodeJwt(accessToken).patient_list).toBeUndefined();

        const allowed = await fhirGet(app, `/Patient/${AUTHORIZED_PATIENT}`, accessToken);
        expect(allowed.status).toBe(200);

        const denied = await fhirGet(app, `/Patient/${OTHER_PATIENT}`, accessToken);
        expect(denied.status).toBe(403);
    });

    it("forwards the authorized patient to the upstream when it injects the patient search param", async () => {
        const app = buildApp();
        const { accessToken } = await launch(app, { patientId: AUTHORIZED_PATIENT }, APP_CLIENT_ID);

        const response = await fhirGet(app, "/Observation", accessToken);

        expect(response.status).toBe(200);
        expect(upstream.patientSearchParams).toEqual([`Patient/${AUTHORIZED_PATIENT}`]);
    });

    it("resolves each app to its own patient when one clinician opens two apps at once", async () => {
        const app = buildApp();
        const first = await launch(app, { patientId: AUTHORIZED_PATIENT }, APP_CLIENT_ID);
        const second = await launch(app, { patientId: OTHER_PATIENT }, OTHER_APP_CLIENT_ID);

        // 同一個 sub、同一個 IdP、兩個 App：token 的 `azp` 兩張都是 gateway 自己。
        expect(decodeJwt(first.accessToken).sub).toBe(decodeJwt(second.accessToken).sub);
        expect(decodeJwt(first.accessToken).azp).toBe(GATEWAY_IDP_CLIENT_ID);

        expect((await fhirGet(app, `/Patient/${AUTHORIZED_PATIENT}`, first.accessToken)).status).toBe(200);
        expect((await fhirGet(app, `/Patient/${AUTHORIZED_PATIENT}`, second.accessToken)).status).toBe(403);
        expect((await fhirGet(app, `/Patient/${OTHER_PATIENT}`, second.accessToken)).status).toBe(200);
        expect((await fhirGet(app, `/Patient/${OTHER_PATIENT}`, first.accessToken)).status).toBe(403);
    });

    it("keeps resolving the launch context after the app refreshes its access token", async () => {
        const app = buildApp();
        const { refreshToken } = await launch(app, { patientId: AUTHORIZED_PATIENT }, APP_CLIENT_ID);

        const refreshResponse = await app.handle(
            gatewayToken({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: APP_CLIENT_ID }),
        );
        expect(refreshResponse.status).toBe(200);
        const refreshed = (await refreshResponse.json()) as { access_token: string };

        const allowed = await fhirGet(app, `/Patient/${AUTHORIZED_PATIENT}`, refreshed.access_token);
        expect(allowed.status).toBe(200);
        const denied = await fhirGet(app, `/Patient/${OTHER_PATIENT}`, refreshed.access_token);
        expect(denied.status).toBe(403);
    });

    it("ignores a patient claim carried by the access token", async () => {
        const app = buildApp();
        await seedLaunchContextForToken(
            store,
            { subject: "clinician-42", clientId: APP_CLIENT_ID, tokenId: "token-with-a-patient-claim" },
            { patientId: AUTHORIZED_PATIENT },
        );
        const token = await signAccessToken({
            jti: "token-with-a-patient-claim",
            patient: OTHER_PATIENT,
            patient_list: "some-list",
            scope: "patient/Patient.read",
        });

        // 硬切：token 裡的病人不是來源，也不會被當成後備。
        expect((await fhirGet(app, `/Patient/${AUTHORIZED_PATIENT}`, token)).status).toBe(200);
        expect((await fhirGet(app, `/Patient/${OTHER_PATIENT}`, token)).status).toBe(403);
    });

    it("refuses a request when the gateway holds no launch context for the token", async () => {
        const app = buildApp();
        const token = await signAccessToken({ jti: "never-issued-by-this-gateway", scope: "patient/Patient.read" });

        expect((await fhirGet(app, `/Patient/${AUTHORIZED_PATIENT}`, token)).status).toBe(401);
    });

    it("refuses a request when the launch context expired before it could be bound", async () => {
        let now = 1_000_000;
        const expiringStore = new InMemoryLaunchContextStore(() => now);
        const app = buildApp({ launchContextTtlSeconds: 60 }, expiringStore);
        const launchId = await registerLaunchContext(app, { patientId: AUTHORIZED_PATIENT });

        now += 60_000;

        expect((await app.handle(gatewayAuthorize(authorizeParams(launchId)))).status).toBe(400);
        // 過期的 launch context 不會留下任何綁定，因此這位醫師的任何 token 都拿不到病人。
        const token = await signAccessToken({ jti: "after-an-expired-launch", scope: "patient/Patient.read" });
        expect((await fhirGet(app, `/Patient/${AUTHORIZED_PATIENT}`, token)).status).toBe(401);
    });

    it("refuses a request once the launch context is no longer in the store", async () => {
        const app = buildApp();
        const { accessToken } = await launch(app, { patientId: AUTHORIZED_PATIENT }, APP_CLIENT_ID);
        expect((await fhirGet(app, `/Patient/${AUTHORIZED_PATIENT}`, accessToken)).status).toBe(200);

        await store.delete("clinician-42", APP_CLIENT_ID);

        expect((await fhirGet(app, `/Patient/${AUTHORIZED_PATIENT}`, accessToken)).status).toBe(401);
    });

    it("refuses a patient-mode request while the launch context store is unreachable", async () => {
        const app = buildApp({}, unreachableLaunchContextStore());
        const token = await signAccessToken({ jti: "any-token", scope: "patient/Patient.read" });

        expect((await fhirGet(app, `/Patient/${AUTHORIZED_PATIENT}`, token)).status).toBe(401);
    });

    it("keeps authorizing a mode that needs no launch context while the store is unreachable", async () => {
        const app = buildApp({ accessChecker: "basic" }, unreachableLaunchContextStore());
        const token = await signAccessToken({ jti: "any-token", scope: "patient/Patient.read" });

        expect((await fhirGet(app, `/Patient/${AUTHORIZED_PATIENT}`, token)).status).toBe(200);
    });

    it("restricts a patient-list launch to the members of the list the EHR registered", async () => {
        const app = buildApp({ accessChecker: "list" });
        const { accessToken } = await launch(app, { patientListId: PATIENT_LIST_ID }, APP_CLIENT_ID);

        // 這是 list 模式第一次真的能用：清單參照由 EHR 建立 context 時指定，
        // 不需要任何 IdP 發得出 `patient_list` claim。
        expect((await fhirGet(app, `/Patient/${AUTHORIZED_PATIENT}`, accessToken)).status).toBe(200);
        expect((await fhirGet(app, `/Patient/${OTHER_PATIENT}`, accessToken)).status).toBe(403);
    });

    it("refuses a list-mode request while the launch context store is unreachable", async () => {
        const app = buildApp({ accessChecker: "list" }, unreachableLaunchContextStore());
        const token = await signAccessToken({ jti: "any-token", scope: "patient/Patient.read" });

        expect((await fhirGet(app, `/Patient/${AUTHORIZED_PATIENT}`, token)).status).toBe(401);
    });
});
