import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type CryptoKey, exportJWK, generateKeyPair, SignJWT } from "jose";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

/** stub IdP 提供 JWKS 的路徑（對齊 Keycloak 的 /protocol/openid-connect/certs） */
export const TEST_JWKS_PATH = "/protocol/openid-connect/certs";

/** stub IdP JWKS 中金鑰的 kid */
export const TEST_JWK_KID = "test-signing-key";

/** stub IdP 提供 authorization endpoint 的路徑（對齊 Keycloak 的 /protocol/openid-connect/auth） */
export const TEST_AUTHORIZATION_PATH = "/protocol/openid-connect/auth";

/** stub IdP 提供 token endpoint 的路徑（對齊 Keycloak 的 /protocol/openid-connect/token） */
export const TEST_TOKEN_PATH = "/protocol/openid-connect/token";

export type IssuerTestKeys = {
    publicKey: CryptoKey;
    privateKey: CryptoKey;
    /** Base64 SPKI DER for Keycloak `public_key` field */
    publicKeyBase64: string;
};

export type IssuerTestServerOptions = {
    /** 是否在 issuer root URL 提供 Keycloak 風格的 public_key（預設 true） */
    servePublicKey?: boolean;
    /** 是否在 TEST_JWKS_PATH 提供 JWKS（預設 false；false 時該端點回 404） */
    serveJwks?: boolean;
    /** discovery document 是否宣告 jwks_uri（預設 true）；false 時移除該欄位 */
    publishJwksUri?: boolean;
    /**
     * JWKS 同時發布幾把金鑰（預設 1）。>1 時另外生成的金鑰不帶在 `keys` 上，
     * 測試多金鑰時 token 只能帶 kid 或完全沒有 kid 兩種形狀。
     */
    jwksKeyCount?: number;
    /**
     * 是否提供 authorization endpoint 與 token endpoint（預設 false）。開啟時 discovery 的
     * `authorization_endpoint`／`token_endpoint` 也改指本機 stub，讓 gateway 轉發得到終點。
     */
    serveAuthorizationFlow?: boolean;
    /** serveAuthorizationFlow 時 IdP 認得的 client id（gateway 拿它當 client 去換 token） */
    clientId?: string;
    /** serveAuthorizationFlow 時 IdP 認得的 client secret */
    clientSecret?: string;
    /** IdP 發出的 access token 的 `sub`（預設 `gateway-user`） */
    subject?: string;
};

/** IdP 記下的一張 authorization code；只能在同一組 code_challenge 下換一次 token。 */
type IssuedTestCode = {
    codeChallenge: string;
    redirectUri: string;
    clientId: string;
    scope: string;
    subject: string;
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
    /** GET authorization endpoint 次數 */
    authorize: number;
    /** POST token endpoint 次數 */
    token: number;
};

/**
 * stub IdP 收到的請求參數。`authorize` 是最近一次 authorization 請求的 query，`token` 是
 * 最近一次 token 請求的 form body——gateway 轉發與 code exchange 的內容都落在這裡。
 */
export type IssuerTestObservations = {
    authorize: Record<string, string> | undefined;
    token: Record<string, string> | undefined;
};

export type IssuerTestServer = {
    issuerUrl: string;
    wellKnownPath: string;
    /** 本次啟動實際提供給 gateway 的 discovery document 原文 */
    wellKnownConfig: string;
    keys: IssuerTestKeys & { kid: string };
    jwksPath: string;
    requests: IssuerTestRequests;
    /** IdP 端實際收到的請求參數：gateway 轉發出去的內容就在這裡 */
    observations: IssuerTestObservations;
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

/** 多金鑰情境用的額外 JWKS 條目；不對外回傳私鑰，測試只能靠 kid 或無 kid 兩種形狀。 */
async function generateExtraJwksKeys(count: number): Promise<Array<Record<string, unknown>>> {
    const entries: Array<Record<string, unknown>> = [];
    for (let index = 0; index < count; index += 1) {
        const { publicKey } = await generateKeyPair("RS256", { extractable: true });
        entries.push({ ...(await exportJWK(publicKey)), alg: "RS256", kid: `${TEST_JWK_KID}-extra-${index + 1}` });
    }
    return entries;
}

/**
 * 本地 issuer 測試伺服器，對齊 Java TokenVerifierTest 的 HttpUtil mock。
 */
export async function startIssuerTestServer(
    wellKnownPath = "test",
    options: IssuerTestServerOptions = {},
): Promise<IssuerTestServer> {
    const {
        servePublicKey = true,
        serveJwks = false,
        publishJwksUri = true,
        jwksKeyCount = 1,
        serveAuthorizationFlow = false,
        clientId = "test-idp-client",
        clientSecret = "test-idp-client-secret",
        subject = "gateway-user",
    } = options;
    const { publicKey, privateKey } = await generateKeyPair("RS256", {
        extractable: true,
    });
    let publicKeyBase64 = await exportSpkiDerBase64(publicKey);
    let jwk: Record<string, unknown> = { ...(await exportJWK(publicKey)), alg: "RS256", kid: TEST_JWK_KID };
    const extraJwks = jwksKeyCount > 1 ? await generateExtraJwksKeys(jwksKeyCount - 1) : [];
    let jwksAvailability: JwksAvailability = "available";
    const discoveryFixture = JSON.parse(readFileSync(join(fixturesDir, "idp_keycloak_config.json"), "utf8"));

    let issuerUrl = "";
    const requests: IssuerTestRequests = { root: 0, wellKnown: 0, jwks: 0, authorize: 0, token: 0 };
    let rotationCount = 0;
    const issuedCodes = new Map<string, IssuedTestCode>();
    const issuedRefreshTokens = new Map<string, IssuedTestCode>();
    const observations: IssuerTestObservations = { authorize: undefined, token: undefined };

    /** 輪替簽章金鑰：JWKS 與 root public_key 同時改發新的 kid 與金鑰 */
    const rotateSigningKey = async (): Promise<IssuerTestKeys & { kid: string }> => {
        rotationCount += 1;
        const rotated = await generateKeyPair("RS256", { extractable: true });
        const kid = `${TEST_JWK_KID}-rotated-${rotationCount}`;
        publicKeyBase64 = await exportSpkiDerBase64(rotated.publicKey);
        jwk = { ...(await exportJWK(rotated.publicKey)), alg: "RS256", kid };
        return { ...rotated, publicKeyBase64, kid };
    };

    /**
     * 本次啟動提供給 gateway 的 discovery document（預設沿用 Keycloak fixture）。
     * `jwks_uri` 一律指向本機 stub：指向 fixture 裡的外部 host 會讓未指定
     * SIGNING_KEY_SOURCE 的測試真的對外連線。
     */
    const buildDiscoveryDocument = (): string => {
        const discovery: Record<string, unknown> = { ...discoveryFixture };
        if (publishJwksUri) {
            discovery.jwks_uri = `${issuerUrl}${TEST_JWKS_PATH}`;
        } else {
            delete discovery.jwks_uri;
        }
        withAuthorizationEndpoints(discovery);
        return JSON.stringify(discovery, null, 4);
    };

    /**
     * serveAuthorizationFlow 時 discovery 的 authorization／token endpoint 改指本機 stub，
     * 讓 gateway 轉發的 `authorize` 與 code exchange 真的抵達這個 IdP。
     */
    const withAuthorizationEndpoints = (discovery: Record<string, unknown>): void => {
        if (!serveAuthorizationFlow) {
            return;
        }
        discovery.authorization_endpoint = `${issuerUrl}${TEST_AUTHORIZATION_PATH}`;
        discovery.token_endpoint = `${issuerUrl}${TEST_TOKEN_PATH}`;
    };

    const signAccessToken = async (code: IssuedTestCode): Promise<string> =>
        new SignJWT({ azp: code.clientId, scope: code.scope, typ: "Bearer" })
            .setProtectedHeader({ alg: "RS256", kid: jwk["kid"] as string })
            .setIssuer(issuerUrl)
            .setSubject(code.subject)
            // `jti` 是 gateway 找回這次 launch context 的索引鍵（ADR-0002），因此每張
            // access token 都要有，而且每張都不同。
            .setJti(randomBytes(16).toString("base64url"))
            .sign(privateKey);

    /**
     * 標準 authorization endpoint：記下 PKCE challenge，發一張單次 code，302 回 redirect_uri。
     * 使用者在 IdP 認證完成的那一刻，gateway 只拿到 `code` 與 `state`。
     */
    const handleAuthorization = (url: URL, res: ServerResponse): void => {
        const params = Object.fromEntries(url.searchParams);
        observations.authorize = params;
        const redirectUri = params["redirect_uri"];
        const codeChallenge = params["code_challenge"];
        const state = params["state"];

        if (params["client_id"] !== clientId || !redirectUri || !codeChallenge) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_request" }));
            return;
        }

        const code = randomBytes(24).toString("base64url");
        issuedCodes.set(code, {
            codeChallenge,
            redirectUri,
            clientId,
            scope: params["scope"] ?? "",
            subject,
        });

        const location = new URL(redirectUri);
        location.searchParams.set("code", code);
        if (state !== undefined) {
            location.searchParams.set("state", state);
        }
        location.searchParams.set("session_state", "stub-session");
        res.writeHead(302, { Location: location.toString() }).end();
    };

    /** 標準 token endpoint：authorization_code 與 refresh_token 兩種 grant。 */
    const handleToken = async (body: string, res: ServerResponse): Promise<void> => {
        const form = Object.fromEntries(new URLSearchParams(body));
        observations.token = form;

        const invalidGrant = (): void => {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_grant" }));
        };

        if (form["client_id"] !== clientId || form["client_secret"] !== clientSecret) {
            invalidGrant();
            return;
        }

        if (form["grant_type"] === "authorization_code") {
            const presentedCode = form["code"] ?? "";
            const code = issuedCodes.get(presentedCode);
            if (
                code === undefined ||
                code.redirectUri !== form["redirect_uri"] ||
                code.codeChallenge !==
                    createHash("sha256")
                        .update(form["code_verifier"] ?? "")
                        .digest("base64url")
            ) {
                invalidGrant();
                return;
            }
            // 單次使用：換過就作廢。
            issuedCodes.delete(presentedCode);
            const refreshToken = randomBytes(24).toString("base64url");
            issuedRefreshTokens.set(refreshToken, code);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
                JSON.stringify({
                    access_token: await signAccessToken(code),
                    refresh_token: refreshToken,
                    token_type: "Bearer",
                    expires_in: 300,
                    scope: code.scope,
                }),
            );
            return;
        }

        if (form["grant_type"] === "refresh_token") {
            const presentedRefreshToken = form["refresh_token"] ?? "";
            const granted = issuedRefreshTokens.get(presentedRefreshToken);
            if (granted === undefined) {
                invalidGrant();
                return;
            }
            const refreshToken = randomBytes(24).toString("base64url");
            issuedRefreshTokens.delete(presentedRefreshToken);
            issuedRefreshTokens.set(refreshToken, granted);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
                JSON.stringify({
                    access_token: await signAccessToken(granted),
                    refresh_token: refreshToken,
                    token_type: "Bearer",
                    expires_in: 300,
                    scope: granted.scope,
                }),
            );
            return;
        }

        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unsupported_grant_type" }));
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
            res.end(JSON.stringify({ keys: [jwk, ...extraJwks] }));
            return;
        }

        if (req.method === "GET" && path === `/${wellKnownPath}`) {
            requests.wellKnown += 1;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(buildDiscoveryDocument());
            return;
        }

        if (serveAuthorizationFlow && req.method === "GET" && path === TEST_AUTHORIZATION_PATH) {
            requests.authorize += 1;
            handleAuthorization(new URL(req.url, issuerUrl), res);
            return;
        }

        if (serveAuthorizationFlow && req.method === "POST" && path === TEST_TOKEN_PATH) {
            requests.token += 1;
            let body = "";
            req.on("data", (chunk: Buffer) => {
                body += chunk.toString("utf8");
            });
            req.on("end", () => {
                void handleToken(body, res);
            });
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
        observations,
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
