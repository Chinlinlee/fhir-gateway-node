import { createPublicKey, type KeyObject } from "node:crypto";

import { z } from "zod";

import { ENV_KEYS } from "../../constants/config";
import { AuthenticationError } from "../../errors/authentication.error";
import { formatErrorMessage } from "../../utils/format-error.util";
import type { HttpUtil } from "../../utils/http.util";
import type { SigningKeyResolver, VerificationKey } from "./signing-key-resolver";

/** Keycloak issuer metadata shape；僅 legacy adapter 使用 */
const KeycloakIssuerMetadataSchema = z.object({
    public_key: z.string().min(1),
});

/**
 * Legacy adapter：GET issuer root URL，取 Keycloak 以 base64 SPKI DER 公布的 public_key。
 *
 * 這是 Keycloak 專屬的驗簽金鑰來源；標準路徑請用 OidcJwksSigningKeyResolver。
 */
export class KeycloakPublicKeySigningKeyResolver implements SigningKeyResolver {
    private constructor(private readonly publicKey: KeyObject) {}

    static async create(
        tokenIssuer: string,
        httpUtil: HttpUtil,
    ): Promise<KeycloakPublicKeySigningKeyResolver> {
        const body = await httpUtil.getTextWithStartupRetry(tokenIssuer, ENV_KEYS.TOKEN_ISSUER);

        let json: unknown;
        try {
            json = JSON.parse(body) as unknown;
        } catch {
            throw new AuthenticationError("Cannot parse issuer metadata as JSON for public_key");
        }

        const parsed = KeycloakIssuerMetadataSchema.safeParse(json);
        if (!parsed.success) {
            throw new AuthenticationError(
                `${ENV_KEYS.SIGNING_KEY_SOURCE}=keycloak-public-key but the issuer root URL ${tokenIssuer} has no 'public_key' field`,
            );
        }

        try {
            // Keycloak returns X.509 SPKI DER as base64 (Java X509EncodedKeySpec).
            const publicKey = createPublicKey({
                key: Buffer.from(parsed.data.public_key, "base64"),
                format: "der",
                type: "spki",
            });
            return new KeycloakPublicKeySigningKeyResolver(publicKey);
        } catch (error) {
            throw new AuthenticationError(`Invalid KeySpec: ${formatErrorMessage(error)}`);
        }
    }

    async resolveVerificationKey(): Promise<VerificationKey> {
        return this.publicKey;
    }
}