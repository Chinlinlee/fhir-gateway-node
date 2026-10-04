import type { JWTPayload } from "jose";

import type { LaunchContext, LaunchContextProvider } from "../types/launch-context";
import type { BoundLaunchContext, LaunchContextStore } from "../types/launch-context-store";
import type { ScopeResolver } from "../types/scope-resolver";
import type { VerifiedJwt } from "../types/verified-jwt";
import { defaultScopeResolver, SCOPE_CLAIM_NAMES } from "./scope-resolver.service";

/**
 * Launch context 的 claim 名稱；claim 名稱設定化（換 IdP）只需改動此處。
 *
 * **清單裡沒有 PHI。** `patient` 與 `patient_list` 兩個 claim 名稱已隨 ADR-0002 移除：
 * launch context 歸 gateway 所有，病人與清單參照改由 launch context store 提供，授權層
 * 沒有任何地方再從 token 讀 PHI。剩下的 `jti` 是 access token 自己的識別碼，gateway 靠它
 * 找回這次授權綁在哪一位病人身上——它是 token 的識別碼，不是病人資訊。
 *
 * `scopes` 與 agent 欄位（`azp`／`iss`／`subject_name`／`name`）仍然從 token 讀：它們不是
 * PHI，而 scope 是 AS 的授權決定，gateway 去猜等於越權。
 *
 * Single place that knows claim names; the authorization layer never reads raw claims.
 */
export const LAUNCH_CLAIM_NAMES = {
    subject: "sub",
    scopes: SCOPE_CLAIM_NAMES.spaceDelimited,
    authorizedParty: "azp",
    issuer: "iss",
    tokenId: "jti",
    subjectName: "subject_name",
    name: "name",
} as const;

/** 原樣讀取字串 claim（對齊 AuditEvent 的 agent 欄位讀法）。 */
function claimAsString(payload: JWTPayload, claim: string): string | undefined {
    const value = payload[claim];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 預設 LaunchContextProvider：病人與清單參照改由 launch context store 查回來，
 * scope 與 agent 身分仍然讀 verified token。
 *
 * store 查不到、已刪除或不可達時，`patientId`／`patientListId` 一律留空——需要 launch context
 * 的 access checker（patient／list）會因此拒絕，而不需要它的模式照常服務。**這裡沒有任何
 * 退回讀 token claim 的路徑**：store 故障絕不可退化為「視為無病人限制」。
 *
 * Default provider: PHI comes from the gateway-owned launch context store; scopes and the
 * agent identity still come from the verified token.
 */
export class DefaultLaunchContextProvider implements LaunchContextProvider {
    constructor(
        private readonly store: LaunchContextStore,
        private readonly scopeResolver: ScopeResolver = defaultScopeResolver,
    ) {}

    async create(token: VerifiedJwt): Promise<LaunchContext> {
        const payload = token.payload;
        const authorizedParty = claimAsString(payload, LAUNCH_CLAIM_NAMES.authorizedParty);
        const issuer = claimAsString(payload, LAUNCH_CLAIM_NAMES.issuer);
        const tokenId = claimAsString(payload, LAUNCH_CLAIM_NAMES.tokenId);
        const subject = claimAsString(payload, LAUNCH_CLAIM_NAMES.subject);
        const displayName =
            claimAsString(payload, LAUNCH_CLAIM_NAMES.subjectName) ?? claimAsString(payload, LAUNCH_CLAIM_NAMES.name);
        const bound = await this.findBoundLaunchContext(tokenId);

        return {
            subject,
            patientId: bound?.patientId,
            patientListId: bound?.patientListId,
            scopes: this.scopeResolver.resolve(payload),
            agent: {
                ...(authorizedParty !== undefined ? { authorizedParty } : {}),
                ...(issuer !== undefined ? { issuer } : {}),
                ...(tokenId !== undefined ? { tokenId } : {}),
                ...(subject !== undefined ? { subject } : {}),
                ...(displayName !== undefined ? { displayName } : {}),
            },
        };
    }

    /**
     * 依 App 帶來的這張 access token 找回綁定。IdP 沒發 `jti` 時沒有索引鍵，同樣視為查無。
     *
     * store 故障在這裡被收斂成「查不到」並留下 server log：對 patient／list 模式等同 401，
     * 對不需要 launch context 的模式等同什麼都沒發生。這是刻意的 fail-closed 形狀。
     */
    private async findBoundLaunchContext(tokenId: string | undefined): Promise<BoundLaunchContext | undefined> {
        if (tokenId === undefined) {
            return undefined;
        }
        try {
            return await this.store.getByAccessToken(tokenId);
        } catch (error) {
            // 只記錄失敗，不記錄 token id 以外的任何東西；token id 本身也不是 PHI。
            console.error(
                `[launch-context] launch context store unavailable: ${
                    error instanceof Error ? error.message : "unknown error"
                }`,
            );
            return undefined;
        }
    }
}
