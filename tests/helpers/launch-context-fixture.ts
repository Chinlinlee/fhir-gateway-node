import type { JWTPayload } from "jose";

import { defaultLaunchContextProvider } from "../../src/services/launch-context.service";
import type { LaunchContext } from "../../src/types/launch-context";

/**
 * 由 token claims 建立 LaunchContext；走預設 provider，因此沿用現行 claim 名稱。
 * Builds a LaunchContext through the default provider, so claim names match production.
 */
export function launchContextFromClaims(claims: JWTPayload = {}): LaunchContext {
    return defaultLaunchContextProvider.create({ payload: claims, protectedHeader: { alg: "RS256" } });
}
