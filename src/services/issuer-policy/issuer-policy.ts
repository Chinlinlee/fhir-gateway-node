import type { GatewayConfig } from "../../configs/env.schema";
import { AuthenticationError } from "../../errors/authentication.error";

export type IssuerPolicyConfig = Pick<GatewayConfig, "tokenIssuer" | "runMode" | "allowTokenIssuerHostMismatch">;

/**
 * Issuer policy：gateway 信任哪些 issuer 的單一決策點。
 *
 * 呼叫端（token verifier）只能取得此介面，三個策略實作一律不匯出，
 * 因此沒有任何呼叫端能繞過 policy 直接套用單一策略。
 */
export interface IssuerPolicy {
    /**
     * 決定 jwtVerify 應使用的 issuer。
     *
     * @param tokenIssuer token payload 的 `iss`
     * @returns 要傳給 jwtVerify 的 issuer
     * @throws AuthenticationError 當沒有任何策略接受此 issuer
     */
    resolveVerificationIssuer(tokenIssuer: string): string;
}

/** 單一策略的判定結果：接受時帶驗簽要使用的 issuer，不接受時為 null（交由下一順位策略）。 */
type IssuerStrategyDecision = { verificationIssuer: string } | null;

interface IssuerMatchStrategy {
    /** 套用此策略，回傳 null 代表此策略不適用於該 token issuer。 */
    evaluate(tokenIssuer: string): IssuerStrategyDecision;
}

function normalizeIssuerPath(issuerUrl: string): string {
    try {
        const pathname = new URL(issuerUrl).pathname.replace(/\/+$/, "");
        return pathname.length > 0 ? pathname : "/";
    } catch {
        return issuerUrl;
    }
}

/**
 * 順位 1 `configured-issuer-exact-match`：token 的 issuer 與設定的 TOKEN_ISSUER
 * 完全相同即接受。排在最前，因此 ALLOW_TOKEN_ISSUER_HOST_MISMATCH 開啟時，
 * 完全相同的 issuer 仍走精確比對。
 */
function configuredIssuerExactMatchStrategy(configuredIssuer: string): IssuerMatchStrategy {
    return {
        evaluate: (tokenIssuer) => (tokenIssuer === configuredIssuer ? { verificationIssuer: configuredIssuer } : null),
    };
}

/**
 * 順位 2 `dev-mode-tolerance`：RUN_MODE=DEV 時容忍 issuer 差異（Android emulator
 * 等情境會帶不同 issuer），警告後信任 token 自己的 issuer。
 */
function devModeToleranceStrategy(configuredIssuer: string, devMode: boolean): IssuerMatchStrategy {
    return {
        evaluate: (tokenIssuer) => {
            if (!devMode) {
                return null;
            }
            console.warn(
                `RUN_MODE=DEV: JWT iss=${tokenIssuer} differs from TOKEN_ISSUER=${configuredIssuer}; verifying with token iss`,
            );
            return { verificationIssuer: tokenIssuer };
        },
    };
}

/**
 * 順位 3 `keycloak-realm-pathname-equivalence`：**Keycloak 專屬**的 realm pathname 等價策略。
 *
 * Keycloak 把 realm 名稱放在 issuer URL 的 pathname（`/realms/<name>`），
 * 因此同一個 realm 在不同 host／port 背後會得到 pathname 相同、host 不同的 issuer URL。
 * ALLOW_TOKEN_ISSUER_HOST_MISMATCH 開啟時視為等價，警告後信任 token 自己的 issuer。
 *
 * 這是對 Keycloak URL 形狀的假設，不是通用的 issuer 等價規則；其他 IdP 不應依賴它。
 */
function keycloakRealmPathnameStrategy(
    configuredIssuer: string,
    allowTokenIssuerHostMismatch: boolean,
): IssuerMatchStrategy {
    return {
        evaluate: (tokenIssuer) => {
            if (!allowTokenIssuerHostMismatch) {
                return null;
            }
            const configuredPath = normalizeIssuerPath(configuredIssuer);
            const jwtPath = normalizeIssuerPath(tokenIssuer);
            if (configuredPath !== jwtPath) {
                return null;
            }
            console.warn(
                `ALLOW_TOKEN_ISSUER_HOST_MISMATCH: iss=${tokenIssuer}, TOKEN_ISSUER=${configuredIssuer}; verifying with token iss (realm path ${configuredPath})`,
            );
            return { verificationIssuer: tokenIssuer };
        },
    };
}

/**
 * 建立 issuer policy。三個策略依固定順位組合，先接受者勝出：
 * `configured-issuer-exact-match` → `dev-mode-tolerance` → `keycloak-realm-pathname-equivalence`。
 * 都無法接受時擲 AuthenticationError。
 */
export function createIssuerPolicy(config: IssuerPolicyConfig): IssuerPolicy {
    const strategies: readonly IssuerMatchStrategy[] = [
        configuredIssuerExactMatchStrategy(config.tokenIssuer),
        devModeToleranceStrategy(config.tokenIssuer, config.runMode === "DEV"),
        keycloakRealmPathnameStrategy(config.tokenIssuer, config.allowTokenIssuerHostMismatch),
    ];

    return {
        resolveVerificationIssuer: (tokenIssuer: string): string => {
            for (const strategy of strategies) {
                const decision = strategy.evaluate(tokenIssuer);
                if (decision !== null) {
                    return decision.verificationIssuer;
                }
            }

            throw new AuthenticationError(
                `The token issuer ${tokenIssuer} does not match the expected token issuer ${config.tokenIssuer}`,
            );
        },
    };
}
