import "./load-env";
import { createApp } from "./app";
import { loadGatewayConfig } from "./configs";
import { StartupConnectionError } from "./errors/startup-connection.error";
import { TokenVerifierService } from "./services/token-verifier.service";

async function main(): Promise<void> {
    const config = loadGatewayConfig();
    const tokenVerifier = await TokenVerifierService.create({
        tokenIssuer: config.tokenIssuer,
        wellKnownEndpoint: config.wellKnownEndpoint,
        runMode: config.runMode,
        allowTokenIssuerHostMismatch: config.allowTokenIssuerHostMismatch,
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
