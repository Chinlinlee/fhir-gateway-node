import { treaty } from "@elysiajs/eden";

import { type App, createApp } from "../../src/app";

export type TestClient = ReturnType<typeof treaty<App>>;

export function createTestClient() {
    const app = createApp();
    const client = treaty(app);
    return { app, client };
}
