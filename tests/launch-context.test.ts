import { describe, expect, it } from "vitest";

import { DefaultLaunchContextProvider } from "../src/services/launch-context.service";
import type { VerifiedJwt } from "../src/types/verified-jwt";
import { launchContextFromClaims } from "./helpers/launch-context-fixture";

function verifiedToken(payload: VerifiedJwt["payload"]): VerifiedJwt {
    return { payload, protectedHeader: { alg: "RS256" } };
}

describe("DefaultLaunchContextProvider agent fields", () => {
    it("prefers subject_name over name for the launch agent display name", () => {
        const launch = launchContextFromClaims({
            sub: "user-123",
            subject_name: "IHE Name",
            name: "OIDC Name",
        });

        expect(launch.agent.displayName).toBe("IHE Name");
    });

    it("falls back to name when the token carries no subject_name", () => {
        const launch = launchContextFromClaims({ sub: "user-123", name: "OIDC Name" });

        expect(launch.agent.displayName).toBe("OIDC Name");
    });

    it("omits the display name when the token carries neither claim", () => {
        const launch = launchContextFromClaims({ sub: "user-123" });

        expect(launch.agent.displayName).toBeUndefined();
    });

    it("maps azp, iss and jti onto the launch agent", () => {
        const provider = new DefaultLaunchContextProvider();

        const launch = provider.create(
            verifiedToken({
                sub: "user-123",
                azp: "test-client",
                iss: "https://issuer.example/realms/smart",
                jti: "jwt-id-1",
            }),
        );

        expect(launch.agent).toEqual({
            authorizedParty: "test-client",
            issuer: "https://issuer.example/realms/smart",
            tokenId: "jwt-id-1",
            subject: "user-123",
        });
        expect(launch.subject).toBe("user-123");
    });

    it("trims the patient claim but keeps agent identity claims verbatim", () => {
        const launch = launchContextFromClaims({ patient: "  456  ", azp: " test-client " });

        expect(launch.patientId).toBe("456");
        expect(launch.agent.authorizedParty).toBe(" test-client ");
    });
});
