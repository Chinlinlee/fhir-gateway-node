import { z } from "zod";

/** Same sentinel as Java AllowedQueriesConfig.MATCHES_ANY_VALUE */
export const MATCHES_ANY_VALUE = "ANY_VALUE";

export const AllowedQueryEntrySchema = z.object({
    path: z.string(),
    requestType: z.string().optional(),
    queryParams: z.record(z.string(), z.string()).default({}),
    allowExtraParams: z.boolean().default(false),
    allParamsRequired: z.boolean().default(false),
    allowUnauthenticatedRequests: z.boolean().default(false),
});

export const AllowedQueriesConfigSchema = z.object({
    entries: z.array(AllowedQueryEntrySchema),
});

export type AllowedQueryEntry = z.infer<typeof AllowedQueryEntrySchema>;
export type AllowedQueriesConfig = z.infer<typeof AllowedQueriesConfigSchema>;
