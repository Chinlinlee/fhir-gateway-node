import { node } from "@elysia/node";
import { Elysia } from "elysia";

import { healthRoute } from "./routes/health.route";

export const createApp = () => new Elysia({ adapter: node() }).use(healthRoute);

export type App = ReturnType<typeof createApp>;
