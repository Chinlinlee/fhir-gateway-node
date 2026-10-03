import type { JWSHeaderParameters } from "jose";
import { importJWK } from "jose";
import { z } from "zod";

import { SIGN_ALGORITHM } from "../../constants/auth";
import { ENV_KEYS } from "../../constants/config";
import { AuthenticationError } from "../../errors/authentication.error";
import { formatErrorMessage } from "../../utils/format-error.util";
import type { HttpUtil } from "../../utils/http.util";
import type { SigningKeyResolver, VerificationKey } from "./signing-key-resolver";

const JwksSchema = z.object({ keys: z.array(z.looseObject({ kid: z.string().min(1).optional() })).min(1) });

type SigningKeySet = {
    /** kid → 公鑰 */
    byKid: Map<string, VerificationKey>;
    /** JWKS 只發布一把金鑰時，token 沒帶 kid 也可驗簽 */
    soloKey: VerificationKey | undefined;
};

async function loadKeySet(jwksUri: string, httpUtil: HttpUtil, timeoutMs?: number): Promise<SigningKeySet> {
    const body =
        timeoutMs === undefined
            ? await httpUtil.getTextWithStartupRetry(jwksUri, ENV_KEYS.TOKEN_ISSUER)
            : await httpUtil.getText(jwksUri, { timeoutMs });

    let json: unknown;
    try {
        json = JSON.parse(body) as unknown;
    } catch {
        throw new AuthenticationError(`Cannot parse the JWKS at ${jwksUri} as JSON`);
    }

    const parsed = JwksSchema.safeParse(json);
    if (!parsed.success) {
        throw new AuthenticationError(`The JWKS at ${jwksUri} does not contain any key`);
    }

    const byKid = new Map<string, VerificationKey>();
    const imported: VerificationKey[] = [];
    for (const entry of parsed.data.keys) {
        const { kid, ...jwk } = entry;
        try {
            const key = await importJWK(jwk, SIGN_ALGORITHM);
            imported.push(key);
            if (kid) {
                byKid.set(kid, key);
            }
        } catch (error) {
            console.warn(`Skipping an unusable key in the JWKS at ${jwksUri}: ${formatErrorMessage(error)}`);
        }
    }

    if (imported.length === 0) {
        throw new AuthenticationError(`The JWKS at ${jwksUri} does not contain any usable ${SIGN_ALGORITHM} key`);
    }

    return { byKid, soloKey: imported.length === 1 ? imported[0] : undefined };
}

/**
 * 標準路徑：依 OIDC discovery document 的 jwks_uri 取得 JWKS，以 kid 選金鑰。
 */
export class OidcJwksSigningKeyResolver implements SigningKeyResolver {
    private constructor(
        private readonly jwksUri: string,
        private readonly keySet: SigningKeySet,
    ) {}

    /**
     * @param timeoutMs 給定時以單次請求載入 JWKS（auto 模式的探測）；未給定則沿用啟動重試。
     */
    static async create(
        jwksUri: string,
        httpUtil: HttpUtil,
        timeoutMs?: number,
    ): Promise<OidcJwksSigningKeyResolver> {
        return new OidcJwksSigningKeyResolver(jwksUri, await loadKeySet(jwksUri, httpUtil, timeoutMs));
    }

    async resolveVerificationKey(protectedHeader: JWSHeaderParameters): Promise<VerificationKey> {
        const kid = protectedHeader.kid;
        if (kid !== undefined) {
            const key = this.keySet.byKid.get(kid);
            if (key) {
                return key;
            }
            // 金鑰輪替路徑：認出未知的 kid 時，在這裡重新載入 JWKS 後再拒絕
            throw new AuthenticationError(`No signing key at ${this.jwksUri} matches kid '${kid}'`);
        }

        if (this.keySet.soloKey) {
            return this.keySet.soloKey;
        }

        throw new AuthenticationError(`The signing token has no 'kid' and ${this.jwksUri} publishes multiple keys`);
    }
}