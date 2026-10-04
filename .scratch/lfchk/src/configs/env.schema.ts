import { z } from "zod";
import { CLAIM_NAME_FIELDS } from "../constants/claim-names";
import { BACKEND_TYPES, DEFAULT_PORT, RUN_MODES, SIGNING_KEY_SOURCES } from "../constants/config";

/**
 * claim 名稱設定：鍵必須是已知的邏輯欄位、值必須是非空字串。
 * 結構性 claim 與其他語意檢查由 `parseClaimNames` 以指名設定的錯誤訊息處理。
 */
const ClaimNamesSchema = z.partialRecord(z.enum(CLAIM_NAME_FIELDS), z.string().min(1));

export const GatewayConfigSchema = z.object({
    proxyTo: z.string().min(1),
    tokenIssuer: z.string().min(1),
    backendType: z.union(BACKEND_TYPES.map((type) => z.literal(type))),
    accessChecker: z.string().min(1),
    allowedQueriesFile: z.string().optional(),
    auditEventActions: z.array(
        z.union([z.literal("C"), z.literal("R"), z.literal("U"), z.literal("D"), z.literal("E")]),
    ),
    claimNames: ClaimNamesSchema.optional(),
    wellKnownEndpoint: z.string().min(1),
    runMode: z.union(RUN_MODES.map((mode) => z.literal(mode))),
    allowTokenIssuerHostMismatch: z.boolean(),
    signingKeySource: z.union(SIGNING_KEY_SOURCES.map((source) => z.literal(source))).optional(),
    port: z.number().int().min(1).max(65535).positive().default(DEFAULT_PORT),
});

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
