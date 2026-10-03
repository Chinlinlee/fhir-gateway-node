import { describe, expect, it } from "vitest";

import { defaultUserWhoFromLaunch } from "../src/types/access-decision";

describe("defaultUserWhoFromLaunch", () => {
    it("builds the audit user from the launch agent's resolved display name and subject", () => {
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

    it("returns null when the launch agent carries neither subject nor issuer", () => {
        expect(defaultUserWhoFromLaunch({})).toBeNull();
    });
});
