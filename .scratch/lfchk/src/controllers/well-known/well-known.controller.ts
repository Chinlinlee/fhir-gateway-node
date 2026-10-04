import type { TokenVerifierService } from "../../services/token-verifier.service";
import type { OidcDiscovery } from "../../validations/oidc-discovery.schema";
import { OidcDiscoverySchema } from "../../validations/oidc-discovery.schema";

export abstract class WellKnownController {
    /**
     * 回傳啟動時向 TOKEN_ISSUER 抓取的 OIDC JSON（不需 Bearer token）。
     */
    static getSmartConfiguration(tokenVerifier: TokenVerifierService): OidcDiscovery {
        const raw = tokenVerifier.getWellKnownConfig();
        const json: unknown = JSON.parse(raw);
        return OidcDiscoverySchema.parse(json);
    }
}
