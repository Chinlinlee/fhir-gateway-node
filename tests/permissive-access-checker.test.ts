import { describe, expect, it } from "vitest";

import { ConfigError, loadGatewayConfig, minimalValidEnv } from "../src/configs";
import { createDefaultAccessCheckerRegistry } from "../src/services/access-checker-registry.service";
import { PermissiveAccessCheckerService } from "../src/services/access-checkers/permissive-access-checker.service";
import { buildFhirRequest } from "./helpers/fhir-request";

describe("PermissiveAccessCheckerService", () => {
    it("grants access for any request", () => {
        const checker = new PermissiveAccessCheckerService();
        expect(checker.checkAccess(buildFhirRequest("Patient/any-id")).canAccess()).toBe(true);
        expect(checker.checkAccess(buildFhirRequest("Observation", { subject: ["any"] }, "DELETE")).canAccess()).toBe(
            true,
        );
    });
});

describe("permissive access checker config", () => {
    it("allows permissive only in DEV mode", () => {
        expect(
            loadGatewayConfig(
                minimalValidEnv({
                    ACCESS_CHECKER: "permissive",
                    RUN_MODE: "DEV",
                }),
            ).accessChecker,
        ).toBe("permissive");

        expect(() =>
            loadGatewayConfig(
                minimalValidEnv({
                    ACCESS_CHECKER: "permissive",
                    RUN_MODE: "PROD",
                }),
            ),
        ).toThrow(ConfigError);
    });

    it("registry registers permissive factory", () => {
        const registry = createDefaultAccessCheckerRegistry();
        const checker = registry.create("permissive", {
            jwt: { payload: { sub: "dev-user" }, protectedHeader: { alg: "RS256" } },
            patientFinder: {
                findPatientsFromParams: () => new Set(),
                findPatientsForAccessCheck: () => new Set(),
                findPatientsInResource: () => new Set(),
                findPatientsInPatch: () => new Set(),
                findPatientsInBundle: () => ({
                    referencedPatients: [],
                    updatedPatients: new Set(),
                    deletedPatients: new Set(),
                    patientsToCreate: false,
                }),
                isPatientCompartmentResource: () => false,
            },
        });
        expect(checker.checkAccess(buildFhirRequest("Patient/x")).canAccess()).toBe(true);
    });
});
