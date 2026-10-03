import { describe, expect, it } from "vitest";

import { defaultUserWhoFromLaunch } from "../src/types/access-decision";

describe("defaultUserWhoFromLaunch", () => {
    it("carries the launch agent display name through to the audit user", () => {
        const who = defaultUserWhoFromLaunch({
            subject: "user-123",
            issuer: "https://issuer.example",
            displayName: "IHE Name",
        });
        expect(who?.display).toBe("IHE Name");
        expect(who?.identifier).toEqual({
            system: "https://issuer.example",
            value: "user-123",
        });
    });

    it("returns null when sub and iss are both missing", () => {
        expect(defaultUserWhoFromLaunch({})).toBeNull();
    });
});
