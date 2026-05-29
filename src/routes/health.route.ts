import { Elysia } from "elysia";

import { HealthController } from "../controllers/health/health.controller";

export const healthRoute = new Elysia({ name: "health" }).get("/health", () => HealthController.getHealth());
