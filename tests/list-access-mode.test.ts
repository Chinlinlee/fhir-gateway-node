import { createServer, type Server } from "node:http";

import { type CryptoKey, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import type { GatewayConfig } from "../src/configs/env.schema";
import { FHIR_API_PREFIX } from "../src/constants/routes";
import { InMemoryLaunchContextStore } from "../src/services/launch-context-store.service";
import { PatientFinderService } from "../src/services/patient-finder.service";
import { TokenVerifierService } from "../src/services/token-verifier.service";
import type { LaunchContextStore } from "../src/types/launch-context-store";
import { type IssuerTestServer, startIssuerTestServer } from "./helpers/issuer-test-server";
import { seedLaunchContextForToken, unreachableLaunchContextStore } from "./helpers/launch-context-fixture";

const PATIENT_LIST_ID = "patient-list-1";
const PATIENT_IN_LIST = "456";
const PATIENT_NOT_IN_LIST = "789";
const PATIENT_CREATED = "created-1";
const LIST_ENTRIES = [`Patient/${PATIENT_IN_LIST}`];

const TOKEN_SUBJECT = "gateway-user";

type UpstreamServer = {
    baseUrl: string;
    /** List PATCH 的 request body；postProcess 新建 Patient 後應送出一次。 */
    listPatches: string[];
    /** 讓 access List 的 PATCH 回指定狀態碼，用來模擬寫入失敗；null 表示正常回 200。 */
    setListPatchStatus: (status: number | null) => void;
    close: () => Promise<void>;
};

function createListModeConfig(issuerUrl: string, proxyTo: string): GatewayConfig {
    return {
        proxyTo,
        tokenIssuer: issuerUrl,
        backendType: "HAPI",
        accessChecker: "list",
        auditEventActions: [],
        wellKnownEndpoint: "test",
        runMode: "PROD",
        allowTokenIssuerHostMismatch: false,
        port: 3000,
    };
}

async function signJwtWithClaims(
    issuer: string,
    privateKey: CryptoKey,
    claims: Record<string, string>,
    jti: string,
): Promise<string> {
    return await new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(issuer)
        .setSubject(TOKEN_SUBJECT)
        .setJti(jti)
        .sign(privateKey);
}

/** 每個測試一組獨立 jti，避免不同測試的綁定在共用 store 裡互相蓋掉。 */
let tokenCounter = 0;
function nextTokenId(): string {
    tokenCounter += 1;
    return `list-mode-token-${tokenCounter}`;
}

/** stub FHIR upstream：提供 patient List allow-list、Patient 資源與 List 寫入。 */
async function startUpstreamServer(): Promise<UpstreamServer> {
    const listPatches: string[] = [];
    let listPatchStatus: number | null = null;
    const server: Server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");

        if (req.method === "GET" && url.pathname === "/fhir/List") {
            if (!url.searchParams.getAll("_id").includes(PATIENT_LIST_ID)) {
                res.writeHead(404, { "content-type": "application/fhir+json" });
                res.end(JSON.stringify({ resourceType: "OperationOutcome" }));
                return;
            }

            const requestedItems = url.searchParams.getAll("item").flatMap((value) => value.split(","));
            const matches = requestedItems.every((item) => LIST_ENTRIES.includes(item));
            const bundle = matches
                ? {
                      resourceType: "Bundle",
                      total: 1,
                      entry: [
                          {
                              resource: {
                                  resourceType: "List",
                                  id: PATIENT_LIST_ID,
                                  status: "current",
                                  mode: "working",
                                  entry: LIST_ENTRIES.map((reference) => ({ item: { reference } })),
                              },
                          },
                      ],
                  }
                : { resourceType: "Bundle", total: 0, entry: [] };
            res.writeHead(200, { "content-type": "application/fhir+json" });
            res.end(JSON.stringify(bundle));
            return;
        }

        if (req.method === "GET" && url.pathname === `/fhir/Patient/${PATIENT_IN_LIST}`) {
            res.writeHead(200, { "content-type": "application/fhir+json" });
            res.end(JSON.stringify({ resourceType: "Patient", id: PATIENT_IN_LIST }));
            return;
        }

        if (req.method === "POST" && url.pathname === "/fhir/Patient") {
            res.writeHead(201, { "content-type": "application/fhir+json" });
            res.end(JSON.stringify({ resourceType: "Patient", id: PATIENT_CREATED }));
            return;
        }

        if (req.method === "PATCH" && url.pathname === `/fhir/List/${PATIENT_LIST_ID}`) {
            let body = "";
            req.on("data", (chunk: Buffer) => {
                body += chunk.toString("utf8");
            });
            req.on("end", () => {
                listPatches.push(body);
                if (listPatchStatus !== null) {
                    res.writeHead(listPatchStatus, { "content-type": "application/fhir+json" });
                    res.end(JSON.stringify({ resourceType: "OperationOutcome" }));
                    return;
                }
                res.writeHead(200, { "content-type": "application/fhir+json" });
                res.end(JSON.stringify({ resourceType: "List", id: PATIENT_LIST_ID }));
            });
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
        listPatches,
        setListPatchStatus: (status: number | null) => {
            listPatchStatus = status;
        },
        baseUrl: `http://127.0.0.1:${address.port}/fhir`,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            }),
    };
}

describe("ACCESS_CHECKER=list over the app seam", () => {
    let issuer: IssuerTestServer;
    let upstream: UpstreamServer;
    let tokenVerifier: TokenVerifierService;
    let launchContextStore: InMemoryLaunchContextStore;

    beforeEach(async () => {
        issuer = await startIssuerTestServer("test");
        upstream = await startUpstreamServer();
        launchContextStore = new InMemoryLaunchContextStore();
        tokenVerifier = await TokenVerifierService.create({
            tokenIssuer: issuer.issuerUrl,
            wellKnownEndpoint: issuer.wellKnownPath,
            runMode: "PROD",
            allowTokenIssuerHostMismatch: false,
        });
    });

    afterEach(async () => {
        await issuer.close();
        await upstream.close();
    });

    const createListModeApp = (launchContextStoreOverride?: LaunchContextStore) =>
        createApp({
            tokenVerifier,
            config: createListModeConfig(issuer.issuerUrl, upstream.baseUrl),
            patientFinder: PatientFinderService.getInstance(),
            launchContextStore: launchContextStoreOverride ?? launchContextStore,
        });

    /** 簽一張 token，並把 patient-list launch context 綁到它的 jti 上（token 裡沒有清單參照）。 */
    async function signListToken(scope: string): Promise<string> {
        const tokenId = nextTokenId();
        await seedLaunchContextForToken(
            launchContextStore,
            { subject: TOKEN_SUBJECT, clientId: "test-app", tokenId },
            { patientListId: PATIENT_LIST_ID },
        );
        return await signJwtWithClaims(issuer.issuerUrl, issuer.keys.privateKey, { scope }, tokenId);
    }

    it("authorizes a patient the named FHIR List includes", async () => {
        const app = createListModeApp();
        const jwt = await signListToken("patient/Patient.read");

        const response = await app.handle(
            new Request(`http://localhost${FHIR_API_PREFIX}/Patient/${PATIENT_IN_LIST}`, {
                headers: { Authorization: `Bearer ${jwt}` },
            }),
        );

        expect(response.status).toBe(200);
        expect(((await response.json()) as { id: string }).id).toBe(PATIENT_IN_LIST);
    });

    it("refuses a patient the named FHIR List does not include", async () => {
        const app = createListModeApp();
        const jwt = await signListToken("patient/Patient.read");

        const response = await app.handle(
            new Request(`http://localhost${FHIR_API_PREFIX}/Patient/${PATIENT_NOT_IN_LIST}`, {
                headers: { Authorization: `Bearer ${jwt}` },
            }),
        );

        expect(response.status).toBe(403);
    });
    it("adds a newly created patient to the named FHIR List", async () => {
        const app = createListModeApp();
        const jwt = await signListToken("patient/Patient.write");

        const response = await app.handle(
            new Request(`http://localhost${FHIR_API_PREFIX}/Patient`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${jwt}`,
                    "content-type": "application/fhir+json",
                },
                body: JSON.stringify({ resourceType: "Patient" }),
            }),
        );

        expect(response.status).toBe(201);
        expect(upstream.listPatches.length).toBe(1);
        expect(upstream.listPatches[0]).toContain(`Patient/${PATIENT_CREATED}`);
    });

    it("returns the upstream response and logs when the access List update fails", async () => {
        const app = createListModeApp();
        const jwt = await signListToken("patient/Patient.write");
        upstream.setListPatchStatus(500);
        const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

        const response = await app.handle(
            new Request(`http://localhost${FHIR_API_PREFIX}/Patient`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${jwt}`,
                    "content-type": "application/fhir+json",
                },
                body: JSON.stringify({ resourceType: "Patient" }),
            }),
        );

        // 上游的 Patient 已經建立成功，改成錯誤只會誘導 client 重試而製造重複資源；
        // 但授權狀態已與回應不一致，因此必須留下可稽核的紀錄。
        expect(response.status).toBe(201);
        expect(logged).toHaveBeenCalledWith(expect.stringContaining("postProcess failed for POST Patient"));
    });

    it("returns 401 naming the missing patient-list field when the token carries none", async () => {
        const app = createListModeApp();
        // jti 沒有對應的綁定，因此這次授權真的沒有任何 launch context。
        const jwt = await signJwtWithClaims(
            issuer.issuerUrl,
            issuer.keys.privateKey,
            { scope: "patient/Patient.read" },
            nextTokenId(),
        );

        const response = await app.handle(
            new Request(`http://localhost${FHIR_API_PREFIX}/Patient/${PATIENT_IN_LIST}`, {
                headers: { Authorization: `Bearer ${jwt}` },
            }),
        );

        expect(response.status).toBe(401);
        const body = (await response.json()) as { issue?: Array<{ diagnostics?: string }> };
        expect(body.issue?.[0]?.diagnostics).toContain("patientListId");
    });

    it("reads the patient-list reference from the launch context, not from raw claims", async () => {
        const app = createListModeApp();
        const tokenId = nextTokenId();
        await seedLaunchContextForToken(
            launchContextStore,
            { subject: TOKEN_SUBJECT, clientId: "test-app", tokenId },
            { patientListId: PATIENT_LIST_ID },
        );
        // token 帶著另一個清單參照：checker 必須讀 store 綁定的那一個，而不是這張 claim。
        const jwt = await signJwtWithClaims(
            issuer.issuerUrl,
            issuer.keys.privateKey,
            { my_list: "a-list-the-store-never-heard-of", scope: "patient/Patient.read" },
            tokenId,
        );

        const response = await app.handle(
            new Request(`http://localhost${FHIR_API_PREFIX}/Patient/${PATIENT_IN_LIST}`, {
                headers: { Authorization: `Bearer ${jwt}` },
            }),
        );

        expect(response.status).toBe(200);
    });

    it("returns 401 when the launch context store cannot be reached", async () => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        const jwt = await signListToken("patient/Patient.read");
        const app = createListModeApp(unreachableLaunchContextStore());

        const response = await app.handle(
            new Request(`http://localhost${FHIR_API_PREFIX}/Patient/${PATIENT_IN_LIST}`, {
                headers: { Authorization: `Bearer ${jwt}` },
            }),
        );

        // store 故障必須 fail closed：token 本身有效，但查不到病人限制就沒有任何授權。
        expect(response.status).toBe(401);
    });
});
