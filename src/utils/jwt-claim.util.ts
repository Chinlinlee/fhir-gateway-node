import type { JWTPayload } from "jose";

import { AuthenticationError } from "../errors/authentication.error";
import { checkFhirIdOrFail } from "./fhir.util";

export function getJwtClaimOrFail(payload: JWTPayload, claim: string): string {
    const value = payload[claim];
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new AuthenticationError(`Missing required JWT claim: ${claim}`);
    }
    return value.trim();
}

export function getJwtClaimIdOrFail(payload: JWTPayload, claim: string): string {
    return checkFhirIdOrFail(getJwtClaimOrFail(payload, claim));
}
