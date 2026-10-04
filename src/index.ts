import "./load-env";
import { createApp } from "./app";
import { loadGatewayConfig } from "./configs";
import { ENV_KEYS } from "./constants/config";
import { StartupConnectionError } from "./errors/startup-connection.error";
import { TokenVerifierService } from "./services/token-verifier.service";

async function main(): Promise<void> {
    const config = loadGatewayConfig();

    // 這個檢查是 opt-in 的，未設定時 gateway 不會校驗 `aud`（RFC 9068 §4 的 MUST 因此未生效）。
    // PROD 保持安靜會讓升級後的部署在不知情的情況下少了這一層防線，因此啟動時明示——
    // 且要在連 IdP 之前印，否則啟動失敗的部署反而看不到這條警告。
    if (config.runMode === "PROD" && !config.tokenAudience) {
        console.warn(
            `${ENV_KEYS.TOKEN_AUDIENCE} is not set: access token audience (aud) is NOT validated. Set it to this gateway's public FHIR base URL (RFC 9068 §4).`,
        );
    }

    const tokenVerifier = await TokenVerifierService.create({
        tokenIssuer: config.tokenIssuer,
        wellKnownEndpoint: config.wellKnownEndpoint,
        runMode: config.runMode,
        allowTokenIssuerHostMismatch: config.allowTokenIssuerHostMismatch,
        signingKeySource: config.signingKeySource,
        tokenAudience: config.tokenAudience,
    });

    createApp({ tokenVerifier, config }).listen(config.port, ({ hostname, port }) => {
        console.log(`FHIR Gateway is running at http://${hostname}:${port}`);
    });
}

main().catch((error) => {
    if (error instanceof StartupConnectionError) {
        console.error(error.message);
        process.exit(1);
    }
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
