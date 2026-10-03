import type { JWTPayload } from "jose";

import { type ClaimNames, resolveClaimNameSettings } from "../../src/constants/claim-names";
import { DefaultLaunchContextProvider } from "../../src/services/launch-context.service";
import type { LaunchContext } from "../../src/types/launch-context";

/**
 * 由 token claims 建立 LaunchContext；走真實的預設 provider，因此 claim 名稱與
 * claim 名稱設定錯誤的行為都與 production 一致。傳入 `claimNames` 會模擬
 * `TOKEN_CLAIM_NAMES` 設定（非預設名稱）。
 *
 * Builds a LaunchContext through the real default provider, so claim names and
 * misconfiguration behaviour match production.
 */
export function launchContextFromClaims(claims: JWTPayload = {}, claimNames?: Partial<ClaimNames>): LaunchContext {
    const provider = new DefaultLaunchContextProvider(resolveClaimNameSettings(claimNames));
    return provider.create({ payload: claims, protectedHeader: { alg: "RS256" } });
}