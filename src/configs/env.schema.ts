import { z } from "zod";
import { BACKEND_TYPES, DEFAULT_PORT, RUN_MODES, SIGNING_KEY_SOURCES } from "../constants/config";

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
    signingKeySource: z.union(SIGNING_KEY_SOURCES.map((source) => z.literal(source))).optional(),
    /** 本 RS 接受的 `aud` 值；未設定或空陣列表示不校驗 `aud`（維持既有行為）。 */
    tokenAudience: z.array(z.string().min(1)).optional(),
    /**
     * 內部 launch context 端點是否啟用；未設定視為未啟用，因此升級既有部署不改變對外行為。
     * Optional so existing deployments that never set it keep behaving exactly as before.
     */
    internalLaunchApiEnabled: z.boolean().optional(),
    /** 內部端點的認證憑證；端點啟用時必填（由 `loadGatewayConfig` 檢查）。 */
    internalLaunchApiCredential: z.string().min(1).optional(),
    /** 未綁定 launch context 的 TTL（秒）；未設定時由解析層填入預設值。 */
    launchContextTtlSeconds: z.number().int().min(1).optional(),
    port: z.number().int().min(1).max(65535).positive().default(DEFAULT_PORT),
});

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
