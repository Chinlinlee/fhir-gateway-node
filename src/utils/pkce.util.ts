import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** PKCE verifier 的長度限制（RFC 7636 §4.1：43–128 個字元）。 */
const PKCE_VERIFIER_BYTES = 32;

/** SMART 的 PKCE 只接受 S256；`plain` 不提供任何保護，gateway 不支援。 */
export const PKCE_CHALLENGE_METHOD_S256 = "S256";

/** gateway 產生一組自己的 PKCE 對，用在它與 IdP 之間的那一趟 code exchange。 */
export function createPkcePair(): { codeVerifier: string; codeChallenge: string } {
    const codeVerifier = randomBytes(PKCE_VERIFIER_BYTES).toString("base64url");
    return { codeVerifier, codeChallenge: deriveS256Challenge(codeVerifier) };
}

/** `code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))` */
export function deriveS256Challenge(codeVerifier: string): string {
    return createHash("sha256").update(codeVerifier).digest("base64url");
}

/**
 * 驗證 App 交來的 `code_verifier` 與 `authorize` 時記下的 challenge 是否相符。
 * 定長比較：兩邊先雜湊到固定長度再 `timingSafeEqual`，不洩漏共同前綴長度。
 */
export function matchesS256Challenge(codeVerifier: string, codeChallenge: string): boolean {
    const presented = Buffer.from(deriveS256Challenge(codeVerifier), "utf8");
    const expected = Buffer.from(codeChallenge, "utf8");
    return presented.length === expected.length && timingSafeEqual(presented, expected);
}
