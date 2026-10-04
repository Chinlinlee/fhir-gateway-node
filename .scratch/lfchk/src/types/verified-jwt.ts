import type { JWTHeaderParameters, JWTPayload } from "jose";

/** Result after signature + issuer checks. */
export type VerifiedJwt = {
    payload: JWTPayload;
    protectedHeader: JWTHeaderParameters;
};
