import { describe, expect, it } from "vitest";

import { AuthenticationError } from "../src/errors/authentication.error";
import {
    AccessCheckerRegistryService,
    createDefaultAccessCheckerRegistry,
} from "../src/services/access-checker-registry.service";
import type { AccessChecker, AccessCheckerFactory } from "../src/types/access-checker";
import { accessGranted } from "../src/types/access-decision";
import { launchContextFromClaims } from "./helpers/launch-context-fixture";

const stubContext = {
    launch: launchContextFromClaims({ sub: "user-1" }),
    patientFinder: {
        findPatientsFromParams: () => new Set<string>(),
        findPatientsForAccessCheck: () => new Set<string>(),
        findPatientsInResource: () => new Set<string>(),
        findPatientsInPatch: () => new Set<string>(),
        findPatientsInBundle: () => ({
            referencedPatients: [],
            updatedPatients: new Set<string>(),
            deletedPatients: new Set<string>(),
            patientsToCreate: false,
        }),
        isPatientCompartmentResource: () => false,
    },
};

describe("AccessCheckerRegistryService", () => {
    it("createDefaultAccessCheckerRegistry registers built-in checkers", () => {
        const registry = createDefaultAccessCheckerRegistry();
        expect(registry.has("permissive")).toBe(true);
        expect(registry.has("list")).toBe(true);
        expect(registry.has("patient")).toBe(true);
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
            checker
                .checkAccess({
                    requestPath: "Observation",
                    requestType: "GET",
                    queryParams: {},
                })
                .canAccess(),
        ).toBe(true);
    });
});
