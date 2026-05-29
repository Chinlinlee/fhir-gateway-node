import { createApp } from "./app";
import { loadGatewayConfig } from "./configs";

try {
    const config = loadGatewayConfig();
    createApp().listen(config.port, ({ hostname, port }) => {
        console.log(`FHIR Gateway is running at http://${hostname}:${port}`);
    });
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
}
