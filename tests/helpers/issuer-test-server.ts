import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { generateKeyPair, SignJWT, type CryptoKey } from "jose";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

export type IssuerTestKeys = {
    publicKey: CryptoKey;
    privateKey: CryptoKey;
    /** Base64 SPKI DER for Keycloak `public_key` field */
    publicKeyBase64: string;
};

export type IssuerTestServer = {
    issuerUrl: string;
    wellKnownPath: string;
    wellKnownConfig: string;
    keys: IssuerTestKeys;
    close: () => Promise<void>;
};

async function exportSpkiDerBase64(publicKey: CryptoKey): Promise<string> {
    const spki = await crypto.subtle.exportKey("spki", publicKey);
    return Buffer.from(spki).toString("base64");
}

/**
 * 本地 issuer 測試伺服器，對齊 Java TokenVerifierTest 的 HttpUtil mock。
 */
export async function startIssuerTestServer(wellKnownPath = "test"): Promise<IssuerTestServer> {
    const { publicKey, privateKey } = await generateKeyPair("RS256", {
        extractable: true,
    });
    const publicKeyBase64 = await exportSpkiDerBase64(publicKey);
    const wellKnownConfig = readFileSync(join(fixturesDir, "idp_keycloak_config.json"), "utf8");

    let issuerUrl = "";

    const server: Server = createServer((req, res) => {
        if (!req.url) {
            res.writeHead(404).end();
            return;
        }

        const path = new URL(req.url, issuerUrl).pathname;

        if (req.method === "GET" && (path === "/" || path === "")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ public_key: publicKeyBase64 }));
            return;
        }

        if (req.method === "GET" && path === `/${wellKnownPath}`) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(wellKnownConfig);
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
        wellKnownConfig,
        keys: { publicKey, privateKey, publicKeyBase64 },
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
