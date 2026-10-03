import type { CryptoKey, JWSHeaderParameters, KeyObject } from "jose";
import { z } from "zod";

import type { SigningKeySource } from "../../constants/config";
import { DEFAULT_SIGNING_KEY_SOURCE, ENV_KEYS } from "../../constants/config";
import { AuthenticationError } from "../../errors/authentication.error";
import { formatErrorMessage } from "../../utils/format-error.util";
import { HttpUtil } from "../../utils/http.util";
import { KeycloakPublicKeySigningKeyResolver } from "./keycloak-public-key-signing-key-resolver";
import { OidcJwksSigningKeyResolver } from "./oidc-jwks-signing-key-resolver";

/** jose 可接受的驗簽公鑰形式 */
export type VerificationKey = CryptoKey | KeyObject | Uint8Array;

/**
 * 驗簽金鑰解析器（signing key resolver）：依 token 的 protected header 取得公鑰。
 *
 * 解析為 per-call：每次驗簽都會依 protected header 的 kid 選一次金鑰。
 * 金鑰在啟動時載入一次；JWKS 輪替出新的 kid 後需重新啟動 gateway 才會生效。
 */
export interface SigningKeyResolver {
    resolveVerificationKey(protectedHeader: JWSHeaderParameters): Promise<VerificationKey>;
}

/** 啟動時解析出的驗簽金鑰來源 */
export type ResolvedSigningKeys = {
    resolver: SigningKeyResolver;
    /** 與金鑰同一次啟動 fetch 取得的 OIDC discovery 文件原文，供 .well-known/smart-configuration 代理使用 */
    discoveryDocument: string;
};

export type ResolveSigningKeysOptions = {
    tokenIssuer: string;
    wellKnownEndpoint: string;
    signingKeySource?: SigningKeySource;
    httpUtil?: HttpUtil;
};

/**
 * auto 模式探測標準路徑的逾時時間（ms）。
 * 探測失敗只是退回 legacy adapter，不該拖慢啟動，因此不重試。
 */
const AUTO_PROBE_TIMEOUT_MS = 1000;

const DiscoveryJwksUriSchema = z.object({ jwks_uri: z.string().min(1).optional() }).loose();

function readJwksUri(discoveryDocument: string, discoveryUrl: string): string | undefined {
    let json: unknown;
    try {
        json = JSON.parse(discoveryDocument) as unknown;
    } catch {
        console.warn(
            `Cannot parse the OIDC discovery document at ${discoveryUrl} as JSON; treating it as having no jwks_uri`,
        );
        return undefined;
    }

    const parsed = DiscoveryJwksUriSchema.safeParse(json);
    return parsed.success ? parsed.data.jwks_uri : undefined;
}

/**
 * 解析啟動時的驗簽金鑰來源。
 *
 * OIDC discovery 文件只抓一次：同一份文件既供金鑰解析，也作為 .well-known/smart-configuration 的代理內容。
 */
export async function resolveSigningKeys(options: ResolveSigningKeysOptions): Promise<ResolvedSigningKeys> {
    const httpUtil = options.httpUtil ?? new HttpUtil();
    const signingKeySource = options.signingKeySource ?? DEFAULT_SIGNING_KEY_SOURCE;

    const discoveryDocument = await httpUtil.fetchWellKnownConfig(
        options.tokenIssuer,
        options.wellKnownEndpoint,
        ENV_KEYS.TOKEN_ISSUER,
    );
    const jwksUri = readJwksUri(discoveryDocument, `${options.tokenIssuer}/${options.wellKnownEndpoint}`);

    if (signingKeySource === "keycloak-public-key") {
        return {
            resolver: await KeycloakPublicKeySigningKeyResolver.create(options.tokenIssuer, httpUtil),
            discoveryDocument,
        };
    }

    if (signingKeySource === "jwks") {
        if (!jwksUri) {
            throw new AuthenticationError(
                `${ENV_KEYS.SIGNING_KEY_SOURCE}=jwks but the OIDC discovery document of ${options.tokenIssuer} has no jwks_uri`,
            );
        }
        return {
            resolver: await OidcJwksSigningKeyResolver.create(jwksUri, httpUtil),
            discoveryDocument,
        };
    }

    // auto：先試標準路徑（jwks_uri），失敗再退回 Keycloak legacy adapter
    if (jwksUri) {
        try {
            const resolver = await OidcJwksSigningKeyResolver.create(jwksUri, httpUtil, AUTO_PROBE_TIMEOUT_MS);
            return { resolver, discoveryDocument };
        } catch (error) {
            console.warn(
                `${ENV_KEYS.SIGNING_KEY_SOURCE}=auto: cannot verify with jwks_uri ${jwksUri} (${formatErrorMessage(error)}); falling back to the Keycloak public_key adapter`,
            );
        }
    }

    return {
        resolver: await KeycloakPublicKeySigningKeyResolver.create(options.tokenIssuer, httpUtil),
        discoveryDocument,
    };
}
