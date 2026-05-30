import { z } from "zod";
import { BACKEND_TYPES, DEFAULT_PORT, RUN_MODES } from "../constants/config";

export const GatewayConfigSchema = z.object({
    proxyTo: z.string().min(1),
    tokenIssuer: z.string().min(1),
    backendType: z.union(BACKEND_TYPES.map((type) => z.literal(type))),
    accessChecker: z.string().min(1),
    allowedQueriesFile: z.string().optional(),
    auditEventActions: z.array(
        z.union([z.literal("C"), z.literal("R"), z.literal("U"), z.literal("D"), z.literal("E")]),
    ),
    wellKnownEndpoint: z.string().min(1),
    runMode: z.union(RUN_MODES.map((mode) => z.literal(mode))),
    allowTokenIssuerHostMismatch: z.boolean(),
    port: z.number().int().min(1).max(65535).positive().default(DEFAULT_PORT),
});

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
