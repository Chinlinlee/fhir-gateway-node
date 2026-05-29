import { createApp } from "./app";

const port = Number(process.env.PORT ?? 3000);

createApp().listen(port, ({ hostname, port: listenPort }) => {
    console.log(`FHIR Gateway is running at http://${hostname}:${listenPort}`);
});
