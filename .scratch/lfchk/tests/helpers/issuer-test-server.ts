import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from "jose";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

/** stub IdP 提供 JWKS 的路徑（對齊 Keycloak 的 /protocol/openid-connect/certs） */
export const TEST_JWKS_PATH = "/protocol/openid-connect/certs";

/** stub IdP JWKS 中金鑰的 kid */
export const TEST_JWK_KID = "test-signing-key";

export type IssuerTestKeys = {
    publicKey: CryptoKey;
    privateKey: CryptoKey;
    /** Base64 SPKI DER for Keycloak `public_key` field */
    publicKeyBase64: string;
};

export type IssuerTestServerOptions = {
    /** 是否在 issuer root URL 提供 Keycloak 風格的 public_key（預設 true） */
    servePublicKey?: boolean;
    /** 是否在 TEST_JWKS_PATH 提供 JWKS，並讓 discovery document 的 jwks_uri 指向本機（預設 false） */
    serveJwks?: boolean;
    /** discovery document 是否宣告 jwks_uri（預設 true）；false 時移除該欄位 */
    publishJwksUri?: boolean;
};

/** JWKS 端點的可用性；unreachable 用來模擬輪替期間 IdP 連不上 */
export type JwksAvailability = "available" | "unreachable";

export type IssuerTestRequests = {
    /** GET issuer root URL（Keycloak public_key）次數 */
    root: number;
    /** GET OIDC discovery document 次數 */
    wellKnown: number;
    /** GET JWKS 次數 */
    jwks: number;
};

export type IssuerTestServer = {
    issuerUrl: string;
    wellKnownPath: string;
    /** 本次啟動實際提供給 gateway 的 discovery document 原文 */
    wellKnownConfig: string;
    keys: IssuerTestKeys & { kid: string };
    jwksPath: string;
    requests: IssuerTestRequests;
    /** 輪替簽章金鑰：改發新的 kid 與金鑰，並回傳新的金鑰組 */
    rotateSigningKey: () => Promise<IssuerTestKeys & { kid: string }>;
    /** 設定 JWKS 端點是否可連線，用來模擬輪替期間 IdP 不可用 */
    setJwksAvailability: (availability: JwksAvailability) => void;
    close: () => Promise<void>;
};

async function exportSpkiDerBase64(publicKey: CryptoKey): Promise<string> {
    const spki = await crypto.subtle.exportKey("spki", publicKey);
    return Buffer.from(spki).toString("base64");
}

/**
 * 本地 issuer 測試伺服器，對齊 Java TokenVerifierTest 的 HttpUtil mock。
 */
export async function startIssuerTestServer(
    wellKnownPath = "test",
    options: IssuerTestServerOptions = {},
): Promise<IssuerTestServer> {
    const { servePublicKey = true, serveJwks = false, publishJwksUri = true } = options;
    const { publicKey, privateKey } = await generateKeyPair("RS256", {
        extractable: true,
    });
    let publicKeyBase64 = await exportSpkiDerBase64(publicKey);
    let jwk: Record<string, unknown> = { ...(await exportJWK(publicKey)), alg: "RS256", kid: TEST_JWK_KID };
    let jwksAvailability: JwksAvailability = "available";
    const discoveryFixture = JSON.parse(readFileSync(join(fixturesDir, "idp_keycloak_config.json"), "utf8"));

    let issuerUrl = "";
    const requests: IssuerTestRequests = { root: 0, wellKnown: 0, jwks: 0 };
    let rotationCount = 0;

    /** 輪替簽章金鑰：JWKS 與 root public_key 同時改發新的 kid 與金鑰 */
    const rotateSigningKey = async (): Promise<IssuerTestKeys & { kid: string }> => {
        rotationCount += 1;
        const rotated = await generateKeyPair("RS256", { extractable: true });
        const kid = `${TEST_JWK_KID}-rotated-${rotationCount}`;
        publicKeyBase64 = await exportSpkiDerBase64(rotated.publicKey);
        jwk = { ...(await exportJWK(rotated.publicKey)), alg: "RS256", kid };
        return { ...rotated, publicKeyBase64, kid };
    };

    /** 本次啟動提供給 gateway 的 discovery document（預設沿用 Keycloak fixture） */
    const buildDiscoveryDocument = (): string => {
        const discovery: Record<string, unknown> = { ...discoveryFixture };
        if (serveJwks) {
            discovery.jwks_uri = `${issuerUrl}${TEST_JWKS_PATH}`;
        }
        if (!publishJwksUri) {
            delete discovery.jwks_uri;
        }
        return JSON.stringify(discovery, null, 4);
    };

    const server: Server = createServer((req, res) => {
        if (!req.url) {
            res.writeHead(404).end();
            return;
        }

        const path = new URL(req.url, issuerUrl).pathname;

        if (req.method === "GET" && (path === "/" || path === "")) {
            requests.root += 1;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(servePublicKey ? { public_key: publicKeyBase64 } : {}));
            return;
        }

        if (req.method === "GET" && path === TEST_JWKS_PATH) {
            requests.jwks += 1;
            if (jwksAvailability === "unreachable") {
                // 直接斷線，讓 gateway 的 fetch 以連線錯誤收場
                req.socket.destroy();
                return;
            }
            if (!serveJwks) {
                res.writeHead(404).end();
                return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ keys: [jwk] }));
            return;
        }

        if (req.method === "GET" && path === `/${wellKnownPath}`) {
            requests.wellKnown += 1;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(buildDiscoveryDocument());
            return;
        }

        res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Failed to bind issuer test server");
    }

    issuerUrl = `http://127.0.0.1:${address.port}`;

    return {
        issuerUrl,
        wellKnownPath,
        wellKnownConfig: buildDiscoveryDocument(),
        jwksPath: TEST_JWKS_PATH,
        requests,
        rotateSigningKey,
        setJwksAvailability: (availability: JwksAvailability) => {
            jwksAvailability = availability;
        },
        keys: { publicKey, privateKey, publicKeyBase64, kid: TEST_JWK_KID },
        close: () =>
            new Promise((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            }),
    };
}

/** Sign RS256 JWT for tests. / 測試用 RS256 簽章 */
export function signTestJwt(issuer: string, privateKey: CryptoKey): Promise<string> {
    return new SignJWT({}).setProtectedHeader({ alg: "RS256" }).setIssuer(issuer).sign(privateKey);
}
