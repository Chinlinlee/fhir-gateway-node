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
 * 金鑰輪替時重新抓取 JWKS 的逾時（ms）。
 * 重新抓取發生在請求路徑上，不能沿用啟動時的重試與等待，否則 IdP 故障會拖慢每個請求。
 */
const JWKS_REFRESH_TIMEOUT_MS = 5000;

/**
 * 標準路徑：依 OIDC discovery document 的 jwks_uri 取得 JWKS，以 kid 選金鑰。
 *
 * 金鑰在啟動時載入一次；遇到不認得的 kid 時重新抓一次 JWKS 再選一次，這就是輪替路徑。
 */
export class OidcJwksSigningKeyResolver implements SigningKeyResolver {
    private keySet: SigningKeySet;
    /** 已為哪些 kid 重新抓過 JWKS；同一個 kid 不再重複抓 */
    private readonly refreshedKids = new Set<string>();
    /** 同一個 kid 的重新抓取只進行一次，同時抵達的請求共用同一個結果 */
    private readonly refreshesInFlight = new Map<string, Promise<void>>();

    private constructor(
        private readonly jwksUri: string,
        private readonly httpUtil: HttpUtil,
        keySet: SigningKeySet,
    ) {
        this.keySet = keySet;
    }

    /**
     * @param timeoutMs 給定時以單次請求載入 JWKS（auto 模式的探測）；未給定則沿用啟動重試。
     */
    static async create(
        jwksUri: string,
        httpUtil: HttpUtil,
        timeoutMs?: number,
    ): Promise<OidcJwksSigningKeyResolver> {
        return new OidcJwksSigningKeyResolver(jwksUri, httpUtil, await loadKeySet(jwksUri, httpUtil, timeoutMs));
    }

    async resolveVerificationKey(protectedHeader: JWSHeaderParameters): Promise<VerificationKey> {
        const kid = protectedHeader.kid;
        if (kid !== undefined) {
            const key = this.keySet.byKid.get(kid);
            if (key) {
                return key;
            }
            // 輪替路徑：JWKS 是啟動時的快照，先重新抓一次再決定要不要拒絕
            await this.refreshOnceFor(kid);
            const rotatedKey = this.keySet.byKid.get(kid);
            if (rotatedKey) {
                return rotatedKey;
            }
            throw new AuthenticationError(`No signing key at ${this.jwksUri} matches kid '${kid}'`);
        }

        if (this.keySet.soloKey) {
            return this.keySet.soloKey;
        }

        throw new AuthenticationError(`The signing token has no 'kid' and ${this.jwksUri} publishes multiple keys`);
    }

    /**
     * 對不認得的 kid 重新抓一次 JWKS；同一個 kid 只抓一次，成功與否都算抓過。
     */
    private async refreshOnceFor(kid: string): Promise<void> {
        if (this.refreshedKids.has(kid)) {
            return;
        }

        // 先等同一個 kid 進行中的重新抓取；不能在等待前就記成「抓過」，
        // 否則同時抵達的請求會直接略過重新抓取，拿著舊快照回 401。
        let inFlight = this.refreshesInFlight.get(kid);
        if (!inFlight) {
            inFlight = this.refreshKeySet().finally(() => {
                this.refreshesInFlight.delete(kid);
            });
            this.refreshesInFlight.set(kid, inFlight);
        }
        await inFlight;
        this.refreshedKids.add(kid);
    }

    /**
     * 重新抓取 JWKS 取代啟動快照。抓不到時保留原本的金鑰，這次請求以 401 收場，
     * 不讓 IdP 在輪替期間的故障變成 500。
     */
    private async refreshKeySet(): Promise<void> {
        try {
            this.keySet = await loadKeySet(this.jwksUri, this.httpUtil, JWKS_REFRESH_TIMEOUT_MS);
        } catch (error) {
            console.warn(`Cannot refresh the JWKS at ${this.jwksUri}: ${formatErrorMessage(error)}`);
        }
    }
}
