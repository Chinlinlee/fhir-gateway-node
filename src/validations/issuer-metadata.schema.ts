import { z } from "zod";

/** Keycloak issuer metadata shape (public_key field). */
export const IssuerMetadataSchema = z.object({
    public_key: z.string().min(1),
});

export type IssuerMetadata = z.infer<typeof IssuerMetadataSchema>;
