import { node } from "@elysia/node";
import { Elysia } from "elysia";

import { corsPlugin } from "./middlewares/cors";
import { healthRoute } from "./routes/health.route";
import { wellKnownRoute } from "./routes/well-known.route";
import type { TokenVerifierService } from "./services/token-verifier.service";

export type CreateAppOptions = {
    tokenVerifier: TokenVerifierService;
};

export const createApp = (options?: CreateAppOptions) => {
    const app = new Elysia({ adapter: node() }).use(corsPlugin).use(healthRoute);

    if (options?.tokenVerifier) {
        app.use(wellKnownRoute(options.tokenVerifier));
    }

    return app;
};

export type App = ReturnType<typeof createApp>;
