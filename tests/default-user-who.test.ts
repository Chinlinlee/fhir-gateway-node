import { describe, expect, it } from "vitest";

import { defaultUserWhoFromJwt } from "../src/types/access-decision";

describe("defaultUserWhoFromJwt", () => {
    it("prefers subject_name over name for display", () => {
        const who = defaultUserWhoFromJwt({
            sub: "user-123",
            iss: "https://issuer.example",
            subject_name: "IHE Name",
            name: "OIDC Name",
        });
        expect(who?.display).toBe("IHE Name");
        expect(who?.identifier).toEqual({
            system: "https://issuer.example",
            value: "user-123",
        });
    });

    it("returns null when sub and iss are both missing", () => {
        expect(defaultUserWhoFromJwt({})).toBeNull();
    });
});
