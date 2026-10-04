import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type CryptoKey, SignJWT } from "jose";
import { fetch as undiciFetch } from "undici";
import { expect } from "vitest";

import type { GatewayConfig } from "../../src/configs/env.schema";
import { SMART_API_PREFIX, SMART_AUTHORIZE_PATH, SMART_TOKEN_PATH } from "../../src/constants/routes";

/**
 * 走完整條 SMART launch 路徑的 app-over-HTTP 測試共用的固定參數與 stub。
 *
 * 這些測試（launch context 由 gateway 持有）都要真的把 `authorize` → IdP → callback →
 * token → FHIR 走一遍，讓綁定由 gateway 自己寫進 store，因此它們的請求形狀必須一致；
 * 共用這份 fixture 也讓兩邊的差異只留在 store 上。
 */

export const GATEWAY_BASE_URL = "https://gateway.example";
export const APP_CLIENT_ID = "smart-app-client";
export const APP_REDIRECT_URI = "https://app.example/callback";
export const OTHER_APP_CLIENT_ID = "other-smart-app-client";
export const APP_STATE = "app-state-0S6_WzA2Mj";
export const GATEWAY_IDP_CLIENT_ID = "gateway-idp-client";
export const GATEWAY_IDP_CLIENT_SECRET = "gateway-idp-client-secret";
export const INTERNAL_CREDENTIAL = "ehr-internal-credential";
export const CODE_VERIFIER = "sBQnbpC_DdE9KZ1TLJKqzKvHqGHvVv0nQrTvVWkGWU8a";
export const CODE_CHALLENGE = createHash("sha256").update(CODE_VERIFIER).digest("base64url");
export const AUTHORIZED_PATIENT = "456";
export const OTHER_PATIENT = "789";
export const PATIENT_LIST_ID = "patient-list-1";
export const PATIENT_LIST_MEMBERS = [`Patient/${AUTHORIZED_PATIENT}`];

export type UpstreamServer = {
    baseUrl: string;
    /** upstream 收到的 `patient` 搜尋參數；patient mode 會由 gateway 注入。 */
    patientSearchParams: string[];
    close: () => Promise<void>;
};

/** stub FHIR upstream：Patient 讀取、Observation search 與 patient list 的 allow-list。 */
export async function startUpstreamServer(): Promise<UpstreamServer> {
    const patientSearchParams: string[] = [];
    const server: Server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");

        if (req.method === "GET" && /^\/fhir\/Patient\/[^/]+$/.test(url.pathname)) {
            const id = url.pathname.replace("/fhir/Patient/", "");
            res.writeHead(200, { "content-type": "application/fhir+json" });
            res.end(JSON.stringify({ resourceType: "Patient", id }));
            return;
        }

        if (req.method === "GET" && url.pathname === "/fhir/Observation") {
            const requested = url.searchParams.getAll("patient");
            patientSearchParams.push(...requested);
            res.writeHead(200, { "content-type": "application/fhir+json" });
            res.end(JSON.stringify({ resourceType: "Bundle", total: 0, entry: [] }));
            return;
        }

        // patient list launch 的 allow-list：只有清單裡的病人算數。
        if (req.method === "GET" && url.pathname === "/fhir/List") {
            const requestedItems = url.searchParams.getAll("item").flatMap((value) => value.split(","));
            const list = url.searchParams.getAll("_id").includes(PATIENT_LIST_ID);
            const allInList = requestedItems.every((item) => PATIENT_LIST_MEMBERS.includes(item));
            const entries = list && allInList ? [{ resource: { resourceType: "List", id: PATIENT_LIST_ID } }] : [];
            res.writeHead(200, { "content-type": "application/fhir+json" });
            res.end(JSON.stringify({ resourceType: "Bundle", total: entries.length, entry: entries }));
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
        patientSearchParams,
        baseUrl: `http://127.0.0.1:${address.port}/fhir`,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            }),
    };
}

export function createBaseConfig(overrides: Partial<GatewayConfig>): GatewayConfig {
    return {
        proxyTo: "http://127.0.0.1:0/fhir",
        tokenIssuer: "http://token-issuer",
        backendType: "HAPI",
        accessChecker: "patient",
        auditEventActions: [],
        wellKnownEndpoint: "test",
        runMode: "PROD",
        allowTokenIssuerHostMismatch: false,
        port: 3000,
        launchContextStoreType: "memory",
        gatewayPublicBaseUrl: GATEWAY_BASE_URL,
        gatewayClientId: GATEWAY_IDP_CLIENT_ID,
        gatewayClientSecret: GATEWAY_IDP_CLIENT_SECRET,
        internalLaunchApiEnabled: true,
        internalLaunchApiCredential: INTERNAL_CREDENTIAL,
        launchContextTtlSeconds: 600,
        ...overrides,
    };
}

export function authorizeParams(launch: string, overrides: Record<string, string> = {}): URLSearchParams {
    return new URLSearchParams({
        response_type: "code",
        client_id: APP_CLIENT_ID,
        redirect_uri: APP_REDIRECT_URI,
        scope: "launch/patient patient/Patient.read patient/Observation.read openid fhirUser",
        aud: "https://fhir.example",
        launch,
        nonce: "n-0S6_WzA2Mj",
        state: APP_STATE,
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: "S256",
        ...overrides,
    });
}

export function gatewayAuthorize(params: URLSearchParams): Request {
    return new Request(`${GATEWAY_BASE_URL}${SMART_API_PREFIX}${SMART_AUTHORIZE_PATH}?${params.toString()}`, {
        redirect: "manual",
    });
}

export function gatewayToken(form: Record<string, string>): Request {
    return new Request(`${GATEWAY_BASE_URL}${SMART_API_PREFIX}${SMART_TOKEN_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
    });
}

export async function locationOf(response: Response): Promise<URL> {
    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    return new URL(location ?? "");
}

export async function authenticateAtIdp(idpRedirect: URL): Promise<URL> {
    const response = await undiciFetch(idpRedirect, { redirect: "manual" });
    return locationOf(response);
}

/**
 * 自己簽一張 IdP access token；用來測試不經代理流程的請求路徑（例如 store 不可達時的裁決）。
 * Token 必須帶 `jti`，否則 gateway 沒有索引鍵可以找回這次授權（ADR-0002）。
 */
export async function signAccessToken(
    issuerUrl: string,
    privateKey: CryptoKey,
    claims: Record<string, string>,
): Promise<string> {
    return await new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(issuerUrl)
        .setSubject("clinician-42")
        .sign(privateKey);
}
