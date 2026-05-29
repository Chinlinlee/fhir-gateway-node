import { describe, expect, it } from "vitest";

import { AuthenticationError } from "../src/errors/authentication.error";
import {
    AccessCheckerRegistryService,
    createDefaultAccessCheckerRegistry,
} from "../src/services/access-checker-registry.service";
import { accessGranted } from "../src/types/access-decision";
import type { AccessChecker, AccessCheckerFactory } from "../src/types/access-checker";
import type { FhirRequestDetails } from "../src/types/fhir-request";

const stubContext = {
    jwt: { payload: { sub: "user-1" }, protectedHeader: { alg: "RS256" } },
    patientFinder: {
        findPatientsFromParams: () => new Set<string>(),
    },
};

describe("AccessCheckerRegistryService", () => {
    it("createDefaultAccessCheckerRegistry registers permissive", () => {
        const registry = createDefaultAccessCheckerRegistry();
        expect(registry.has("permissive")).toBe(true);
        const checker = registry.create("permissive", stubContext);
        const decision = checker.checkAccess({
            requestPath: "Patient",
            requestType: "GET",
            queryParams: {},
        });
        expect(decision.canAccess()).toBe(true);
    });

    it("throws AuthenticationError for unknown checker name", () => {
        const registry = new AccessCheckerRegistryService();
        expect(() => registry.create("unknown", stubContext)).toThrow(AuthenticationError);
    });

    it("register and create custom factory", () => {
        const registry = new AccessCheckerRegistryService();
        const factory: AccessCheckerFactory = {
            create: (): AccessChecker => ({
                checkAccess: () => accessGranted(),
            }),
        };
        registry.register("custom", factory);
        const checker = registry.create("custom", stubContext);
        expect(
            checker.checkAccess({
                requestPath: "Observation",
                requestType: "GET",
                queryParams: {},
            }).canAccess(),
        ).toBe(true);
    });
});
