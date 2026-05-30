import { createApp } from "./app";
import { loadGatewayConfig } from "./configs";
import { TokenVerifierService } from "./services/token-verifier.service";

async function main(): Promise<void> {
    const config = loadGatewayConfig();
    const tokenVerifier = await TokenVerifierService.create({
        tokenIssuer: config.tokenIssuer,
        wellKnownEndpoint: config.wellKnownEndpoint,
        runMode: config.runMode,
    });

    createApp({ tokenVerifier, config }).listen(config.port, ({ hostname, port }) => {
        console.log(`FHIR Gateway is running at http://${hostname}:${port}`);
    });
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
