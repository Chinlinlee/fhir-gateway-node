import { SMART_API_PREFIX, SMART_AUTHORIZE_PATH, SMART_TOKEN_PATH } from "../../constants/routes";
import type { TokenVerifierService } from "../../services/token-verifier.service";
import { smartEndpointUrl } from "../../utils/smart-endpoint.util";
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

    /**
     * 同一份 IdP 文件，但 `authorization_endpoint` 與 `token_endpoint` 改指 gateway 自己——
     * gateway 現在代理這兩個端點。
     *
     * `issuer` 維持 IdP 的原值：access token 的 `iss` 仍然是 IdP，App 既有的 issuer 檢查
     * 才一致。改寫用的 base URL 來自設定，不是請求的 `Host` header。
     */
    static getProxiedSmartConfiguration(tokenVerifier: TokenVerifierService, publicBaseUrl: string): OidcDiscovery {
        const discovery = WellKnownController.getSmartConfiguration(tokenVerifier);
        return {
            ...discovery,
            authorization_endpoint: smartEndpointUrl(publicBaseUrl, `${SMART_API_PREFIX}${SMART_AUTHORIZE_PATH}`),
            token_endpoint: smartEndpointUrl(publicBaseUrl, `${SMART_API_PREFIX}${SMART_TOKEN_PATH}`),
        };
    }
}
