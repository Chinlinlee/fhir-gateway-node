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
    /** 可用金鑰數；回報「無法唯一決定用哪一把驗簽」時用 */
    keyCount: number;
};

async function loadKeySet(jwksUri: string, httpUtil: HttpUtil, timeoutMs?: number): Promise<SigningKeySet> {
    const body =
        timeoutMs === undefined
            ? await httpUtil.getTextWithStartupRetry(jwksUri, ENV_KEYS.SIGNING_KEY_SOURCE)
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

    return { byKid, soloKey: imported.length === 1 ? imported[0] : undefined, keyCount: imported.length };
}

/**
 * 金鑰輪替時重新抓取 JWKS 的逾時（ms）。
 * 重新抓取發生在請求路徑上，不能沿用啟動時的重試與等待，否則 IdP 故障會拖慢每個請求。
 */
const JWKS_REFRESH_TIMEOUT_MS = 5000;

/**
 * 未知 kid 的重新抓取上限。
 *
 * `jose` 以**未驗證**的 protected header 選金鑰，因此任何語法合法的 JWT 只要帶著任意的
 * `kid` 就會進入重新抓取分支。若不設上限，N 個不同 `kid` 就是 N 次對外 GET JWKS，
 * 攻擊者不需任何有效 token 即可放大對 IdP 的請求。這裡同時限制：
 *
 * - 對外工作量：時間窗內最多 `MAX_UNKNOWN_KID_REFRESHES` 次重新抓取，超過即拒絕（fail-closed）。
 * - 記憶體：時間窗紀錄最多保留同樣數量的 kid，因此不會無上限成長。
 */
const JWKS_REFRESH_WINDOW_MS = 60_000;
const MAX_UNKNOWN_KID_REFRESHES = 5;

/**
 * 標準路徑：依 OIDC discovery document 的 jwks_uri 取得 JWKS，以 kid 選金鑰。
 *
 * 金鑰在啟動時載入一次；遇到不認得的 kid 時重新抓一次 JWKS 再選一次，這就是輪替路徑。
 */
export class OidcJwksSigningKeyResolver implements SigningKeyResolver {
    private keySet: SigningKeySet;
    /** 時間窗內已為哪些 kid 重新抓過 JWKS；同一個 kid 不再重複抓，長度恆有上限 */
    private readonly refreshedKids: Array<{ kid: string; at: number }> = [];
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
    static async create(jwksUri: string, httpUtil: HttpUtil, timeoutMs?: number): Promise<OidcJwksSigningKeyResolver> {
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

        // JWKS 只發布一把可用金鑰時，沒有 kid 的 token 仍可驗簽。
        if (this.keySet.soloKey) {
            return this.keySet.soloKey;
        }

        // 多把金鑰卻沒有 kid，無法唯一決定用哪一把驗簽；拒絕而不是逐一嘗試。
        throw new AuthenticationError(
            `Cannot verify the token: it carries no 'kid' and the JWKS at ${this.jwksUri} publishes ${this.keySet.keyCount} keys, so no single verification key can be chosen`,
        );
    }

    /**
     * 對不認得的 kid 重新抓一次 JWKS；同一個 kid 在時間窗內只抓一次，成功與否都算抓過。
     */
    private async refreshOnceFor(kid: string): Promise<void> {
        const now = Date.now();
        while (this.refreshedKids.length > 0 && now - (this.refreshedKids[0]?.at ?? 0) >= JWKS_REFRESH_WINDOW_MS) {
            this.refreshedKids.shift();
        }
        // 先等同一個 kid 進行中的重新抓取；不能在等待前就當成「抓過」，
        // 否則同時抵達的請求會直接略過重新抓取，拿著舊快照回 401。
        const started = this.refreshesInFlight.get(kid);
        if (started) {
            await started;
            return;
        }

        if (this.refreshedKids.some((refreshed) => refreshed.kid === kid)) {
            return;
        }

        if (this.refreshedKids.length >= MAX_UNKNOWN_KID_REFRESHES) {
            // 預算用盡：不再對外抓取，直接拒絕。絕不因為抓不到就放行。
            throw new AuthenticationError(
                `Refusing to re-fetch the JWKS at ${this.jwksUri} for kid '${kid}': more than ${MAX_UNKNOWN_KID_REFRESHES} unknown kids were already seen within ${JWKS_REFRESH_WINDOW_MS}ms`,
            );
        }
        this.refreshedKids.push({ kid, at: now });
        const inFlight = this.refreshKeySet().finally(() => {
            this.refreshesInFlight.delete(kid);
        });
        this.refreshesInFlight.set(kid, inFlight);
        await inFlight;
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
