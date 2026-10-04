import { type CryptoKey, decodeJwt, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import type { GatewayConfig } from "../src/configs/env.schema";
import { AllowedQueriesCheckerService } from "../src/services/allowed-queries.service";
import { InMemoryLaunchContextStore } from "../src/services/launch-context-store.service";
import { PatientFinderService } from "../src/services/patient-finder.service";
import { TokenVerifierService } from "../src/services/token-verifier.service";
import type { LaunchContextStore } from "../src/types/launch-context-store";
import { type IssuerTestServer, startIssuerTestServer } from "./helpers/issuer-test-server";
import { seedLaunchContextForToken, unreachableLaunchContextStore } from "./helpers/launch-context-fixture";
import {
    APP_CLIENT_ID,
    AUTHORIZED_PATIENT,
    authorizeParams,
    CLINICIAN_SUBJECT,
    createBaseConfig,
    fhirGet,
    GATEWAY_IDP_CLIENT_ID,
    GATEWAY_IDP_CLIENT_SECRET,
    gatewayAuthorize,
    gatewayToken,
    launch,
    OTHER_APP_CLIENT_ID,
    OTHER_PATIENT,
    PATIENT_LIST_ID,
    registerLaunchContext,
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

/** 綁定後的 TTL：短到測試可以用替身時鐘跨過它，又夠長到不會干擾其他案例。 */
const BOUND_TTL_SECONDS = 3600;

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

    /** 自己簽一張 IdP access token；用來測試「不經代理流程」的請求路徑。 */
    const signAccessToken = async (claims: Record<string, string>): Promise<string> =>
        await new SignJWT(claims)
            .setProtectedHeader({ alg: "RS256" })
            .setIssuer(issuer.issuerUrl)
            .setSubject(CLINICIAN_SUBJECT)
            .sign(issuer.keys.privateKey as CryptoKey);

    it("authorizes to the launch context the gateway recorded, with no patient in the access token", async () => {
        const app = buildApp();
        const { access_token: accessToken } = await launch(app, { patientId: AUTHORIZED_PATIENT });

        expect(decodeJwt(accessToken).patient).toBeUndefined();
        expect(decodeJwt(accessToken).patient_list).toBeUndefined();

        expect((await fhirGet(app, `/Patient/${AUTHORIZED_PATIENT}`, accessToken)).status).toBe(200);
        expect((await fhirGet(app, `/Patient/${OTHER_PATIENT}`, accessToken)).status).toBe(403);
    });

    it("authorizes the patient the internal launch context endpoint registered, encounter included", async () => {
        const app = buildApp();

        // 內部端點帶著 encounter 一起註冊時，綁定仍然授權到**那位病人**：就診參照不會蓋掉
        // 病人參照，也不會讓這次 launch 授權不出去。
        const { access_token: accessToken } = await launch(app, {
            patientId: AUTHORIZED_PATIENT,
            encounterId: "enc-1",
        });

        expect((await fhirGet(app, `/Patient/${AUTHORIZED_PATIENT}`, accessToken)).status).toBe(200);
        expect((await fhirGet(app, `/Patient/${OTHER_PATIENT}`, accessToken)).status).toBe(403);
    });

    it("forwards the authorized patient to the upstream when it injects the patient search param", async () => {
        const app = buildApp();
        const { access_token: accessToken } = await launch(app, { patientId: AUTHORIZED_PATIENT });

        const response = await fhirGet(app, "/Observation", accessToken);

        expect(response.status).toBe(200);
        expect(upstream.patientSearchParams).toEqual([`Patient/${AUTHORIZED_PATIENT}`]);
    });

    it("resolves each app to its own patient when one clinician opens two apps at once", async () => {
        const app = buildApp();
        const first = await launch(app, { patientId: AUTHORIZED_PATIENT }, APP_CLIENT_ID);
        const second = await launch(app, { patientId: OTHER_PATIENT }, OTHER_APP_CLIENT_ID);

        // 同一個 sub、同一個 IdP、兩個 App：token 的 `azp` 兩張都是 gateway 自己。
        expect(decodeJwt(first.access_token).sub).toBe(decodeJwt(second.access_token).sub);
        expect(decodeJwt(first.access_token).azp).toBe(GATEWAY_IDP_CLIENT_ID);

        expect((await fhirGet(app, `/Patient/${AUTHORIZED_PATIENT}`, first.access_token)).status).toBe(200);
        expect((await fhirGet(app, `/Patient/${AUTHORIZED_PATIENT}`, second.access_token)).status).toBe(403);
        expect((await fhirGet(app, `/Patient/${OTHER_PATIENT}`, second.access_token)).status).toBe(200);
        expect((await fhirGet(app, `/Patient/${OTHER_PATIENT}`, first.access_token)).status).toBe(403);
    });

    it("lets one clinician launch the same app again for another patient", async () => {
        const app = buildApp();

        await launch(app, { patientId: AUTHORIZED_PATIENT }, APP_CLIENT_ID);
        const second = await launch(app, { patientId: OTHER_PATIENT }, APP_CLIENT_ID);

        // 第二次 launch 成功，而且拿到的是新那位病人。
        expect((await fhirGet(app, `/Patient/${OTHER_PATIENT}`, second.access_token)).status).toBe(200);
        expect((await fhirGet(app, `/Patient/${AUTHORIZED_PATIENT}`, second.access_token)).status).toBe(403);
    });

    it("never lets a token issued for one patient start authorizing another", async () => {
        const app = buildApp();
        const first = await launch(app, { patientId: AUTHORIZED_PATIENT }, APP_CLIENT_ID);

        await launch(app, { patientId: OTHER_PATIENT }, APP_CLIENT_ID);

        // 這是這條路徑的安全前提：第一張 token 在醫師再次 launch 之後**forever** 解析到它被
        // 發放時的那一筆綁定。若索引經過 `(subject, client id)` 這組粗鍵，這裡就會變成 200。
        expect((await fhirGet(app, `/Patient/${AUTHORIZED_PATIENT}`, first.access_token)).status).toBe(200);
        expect((await fhirGet(app, `/Patient/${OTHER_PATIENT}`, first.access_token)).status).toBe(403);
    });

    it("keeps a refreshed token on the patient its authorization was issued for", async () => {
        const app = buildApp();
        const first = await launch(app, { patientId: AUTHORIZED_PATIENT }, APP_CLIENT_ID);

        // 醫師在 refresh 之前又開了同一次 App 的另一次 launch。refresh 屬於第一次授權，
        // 因此換發的 token 必須接回第一次那筆綁定，而不是這組鍵「目前」指向的那筆。
        await launch(app, { patientId: OTHER_PATIENT }, APP_CLIENT_ID);

        const refreshResponse = await app.handle(
            gatewayToken({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: APP_CLIENT_ID }),
        );
        expect(refreshResponse.status).toBe(200);
        const refreshed = (await refreshResponse.json()) as { access_token: string };

        expect((await fhirGet(app, `/Patient/${AUTHORIZED_PATIENT}`, refreshed.access_token)).status).toBe(200);
        expect((await fhirGet(app, `/Patient/${OTHER_PATIENT}`, refreshed.access_token)).status).toBe(403);
    });

    it("keeps resolving the launch context after the app refreshes its access token", async () => {
        const app = buildApp();
        const { refresh_token: refreshToken } = await launch(app, { patientId: AUTHORIZED_PATIENT });

        const refreshResponse = await app.handle(
            gatewayToken({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: APP_CLIENT_ID }),
        );
        expect(refreshResponse.status).toBe(200);
        const refreshed = (await refreshResponse.json()) as { access_token: string };

        expect((await fhirGet(app, `/Patient/${AUTHORIZED_PATIENT}`, refreshed.access_token)).status).toBe(200);
        expect((await fhirGet(app, `/Patient/${OTHER_PATIENT}`, refreshed.access_token)).status).toBe(403);
    });

    it("ignores a patient claim carried by the access token", async () => {
        const app = buildApp();
        await seedLaunchContextForToken(
            store,
            { subject: CLINICIAN_SUBJECT, clientId: APP_CLIENT_ID, tokenId: "token-with-a-patient-claim" },
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

    it("refuses a request once the bound launch context has expired", async () => {
        let now = 1_000_000;
        const expiringStore = new InMemoryLaunchContextStore(() => now, BOUND_TTL_SECONDS);
        const app = buildApp({}, expiringStore);
        const { access_token: accessToken } = await launch(app, { patientId: AUTHORIZED_PATIENT });
        expect((await fhirGet(app, `/Patient/${AUTHORIZED_PATIENT}`, accessToken)).status).toBe(200);

        now += BOUND_TTL_SECONDS * 1000;

        // 綁定後的 context 也有 TTL：到期之後這張 token 查不到病人，因此是 401 而不是 403。
        expect((await fhirGet(app, `/Patient/${AUTHORIZED_PATIENT}`, accessToken)).status).toBe(401);
    });

    it("refuses a list-mode request once the bound launch context has expired", async () => {
        let now = 1_000_000;
        const expiringStore = new InMemoryLaunchContextStore(() => now, BOUND_TTL_SECONDS);
        const app = buildApp({ accessChecker: "list" }, expiringStore);
        const { access_token: accessToken } = await launch(app, { patientListId: PATIENT_LIST_ID });
        expect((await fhirGet(app, `/Patient/${AUTHORIZED_PATIENT}`, accessToken)).status).toBe(200);

        now += BOUND_TTL_SECONDS * 1000;

        expect((await fhirGet(app, `/Patient/${AUTHORIZED_PATIENT}`, accessToken)).status).toBe(401);
    });

    it("refuses a request when the launch context expired before it could be bound", async () => {
        let now = 1_000_000;
        const expiringStore = new InMemoryLaunchContextStore(() => now);
        const app = buildApp({ launchContextTtlSeconds: 60 }, expiringStore);
        const launchId = await registerLaunchContext(app, { patientId: AUTHORIZED_PATIENT });

        now += 60_000;

        // 未綁定的 context 到期之後連綁都綁不上：authorize 擋掉它，IdP 完全不知道這次 launch。
        expect((await app.handle(gatewayAuthorize(authorizeParams(launchId)))).status).toBe(400);
        expect(await expiringStore.bind(launchId, CLINICIAN_SUBJECT, APP_CLIENT_ID)).toBeUndefined();
        // 因此這位醫師的任何 token 都拿不到病人。
        const token = await signAccessToken({ jti: "after-an-expired-launch", scope: "patient/Patient.read" });
        expect((await fhirGet(app, `/Patient/${AUTHORIZED_PATIENT}`, token)).status).toBe(401);
    });

    it("refuses a request once the launch context is no longer in the store", async () => {
        const app = buildApp();
        const { access_token: accessToken } = await launch(app, { patientId: AUTHORIZED_PATIENT });
        expect((await fhirGet(app, `/Patient/${AUTHORIZED_PATIENT}`, accessToken)).status).toBe(200);

        await store.delete(CLINICIAN_SUBJECT, APP_CLIENT_ID);

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
        const { access_token: accessToken } = await launch(app, { patientListId: PATIENT_LIST_ID });

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
