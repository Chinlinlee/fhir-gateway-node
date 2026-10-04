import { Elysia } from "elysia";
import { INTERNAL_LAUNCH_API_PREFIX, LAUNCH_CONTEXTS_PATH } from "../constants/routes";
import type { InternalLaunchDeps } from "../controllers/internal-launch/internal-launch.controller";
import { InternalLaunchController } from "../controllers/internal-launch/internal-launch.controller";

/**
 * EHR 面向的內部 launch context 端點。只有 `INTERNAL_LAUNCH_API_ENABLED` 為真時才註冊。
 * EHR-facing internal launch context endpoint; registered only when explicitly enabled.
 */
export const internalLaunchRoute = (deps: InternalLaunchDeps) =>
    new Elysia({ name: "internal-launch", prefix: INTERNAL_LAUNCH_API_PREFIX }).post(
        LAUNCH_CONTEXTS_PATH,
        ({ request }) => InternalLaunchController.register(request, deps),
    );
