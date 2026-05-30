import { describe, expect, it } from "vitest";

import {
    ALL_RESOURCE_TYPES_WILDCARD,
    extractSmartFhirScopesFromTokens,
    resolveSmartScopePrincipal,
    SmartScopeChecker,
    SmartScopePermission,
    SmartScopePrincipal,
} from "../src/services/smart-scope.service";

describe("SmartScopeChecker", () => {
    it("hasPermissionCreateObservationPatientPrincipal", () => {
        const scopeChecker = new SmartScopeChecker(
            extractSmartFhirScopesFromTokens([
                "user/Encounter.read",
                "patient/Observation.read",
                "patient/Observation.write",
            ]),
            SmartScopePrincipal.PATIENT,
        );

        expect(scopeChecker.hasPermission("Observation", SmartScopePermission.CREATE)).toBe(true);
    });

    it("hasPermissionCreateObservationPatientPrincipalNoValidScope", () => {
        const scopeChecker = new SmartScopeChecker(
            extractSmartFhirScopesFromTokens(["user/Observation.create", "patient/Observation.read"]),
            SmartScopePrincipal.PATIENT,
        );

        expect(scopeChecker.hasPermission("Observation", SmartScopePermission.CREATE)).toBe(false);
    });

    it("hasPermissionReadObservationPatientPrincipalAllResources", () => {
        const scopeChecker = new SmartScopeChecker(
            extractSmartFhirScopesFromTokens(["user/*.read", "patient/Observation.write"]),
            SmartScopePrincipal.PATIENT,
        );

        expect(scopeChecker.hasPermission("Observation", SmartScopePermission.READ)).toBe(false);
    });

    it("hasPermissionDeleteObservationPatientPrincipalAllResources", () => {
        const scopeChecker = new SmartScopeChecker(
            extractSmartFhirScopesFromTokens(["patient/*.read", "patient/Observation.write"]),
            SmartScopePrincipal.PATIENT,
        );

        expect(scopeChecker.hasPermission("Observation", SmartScopePermission.DELETE)).toBe(true);
    });

    it("hasPermissionCreateObservationV2Scopes", () => {
        const scopeChecker = new SmartScopeChecker(
            extractSmartFhirScopesFromTokens(["patient/*.rs", "patient/Observation.u"]),
            SmartScopePrincipal.PATIENT,
        );

        expect(scopeChecker.hasPermission("Observation", SmartScopePermission.CREATE)).toBe(false);
    });

    it("hasPermissionDeleteObservationV2Scopes", () => {
        const scopeChecker = new SmartScopeChecker(
            extractSmartFhirScopesFromTokens(["user/*.rs", "user/Observation.cr"]),
            SmartScopePrincipal.PATIENT,
        );

        expect(scopeChecker.hasPermission("Observation", SmartScopePermission.DELETE)).toBe(false);
    });
});

describe("extractSmartFhirScopesFromTokens", () => {
    it("maps v1 read to READ and SEARCH", () => {
        const scopes = extractSmartFhirScopesFromTokens(["patient/Observation.read"]);
        expect(scopes).toHaveLength(1);
        expect(scopes[0]?.principal).toBe(SmartScopePrincipal.PATIENT);
        expect(scopes[0]?.resourceType).toBe("Observation");
        expect(scopes[0]?.permissions.has(SmartScopePermission.READ)).toBe(true);
        expect(scopes[0]?.permissions.has(SmartScopePermission.SEARCH)).toBe(true);
        expect(scopes[0]?.permissions.has(SmartScopePermission.CREATE)).toBe(false);
    });

    it("maps v1 write to CREATE UPDATE DELETE", () => {
        const scopes = extractSmartFhirScopesFromTokens(["patient/Encounter.write"]);
        expect(scopes[0]?.permissions.has(SmartScopePermission.CREATE)).toBe(true);
        expect(scopes[0]?.permissions.has(SmartScopePermission.UPDATE)).toBe(true);
        expect(scopes[0]?.permissions.has(SmartScopePermission.DELETE)).toBe(true);
        expect(scopes[0]?.permissions.has(SmartScopePermission.READ)).toBe(false);
    });

    it("maps wildcard permission to all operations", () => {
        const scopes = extractSmartFhirScopesFromTokens(["patient/Patient.*"]);
        for (const permission of Object.values(SmartScopePermission)) {
            expect(scopes[0]?.permissions.has(permission)).toBe(true);
        }
    });

    it("parses v2 cruds in canonical order", () => {
        const scopes = extractSmartFhirScopesFromTokens(["patient/Observation.cruds"]);
        expect(scopes[0]?.permissions.has(SmartScopePermission.CREATE)).toBe(true);
        expect(scopes[0]?.permissions.has(SmartScopePermission.READ)).toBe(true);
        expect(scopes[0]?.permissions.has(SmartScopePermission.UPDATE)).toBe(true);
        expect(scopes[0]?.permissions.has(SmartScopePermission.DELETE)).toBe(true);
        expect(scopes[0]?.permissions.has(SmartScopePermission.SEARCH)).toBe(true);
    });

    it("accepts resource type wildcard", () => {
        const scopes = extractSmartFhirScopesFromTokens(["patient/*.read"]);
        expect(scopes[0]?.resourceType).toBe(ALL_RESOURCE_TYPES_WILDCARD);
    });

    it("skips non-SMART tokens", () => {
        const scopes = extractSmartFhirScopesFromTokens([
            "openid",
            "profile",
            "patient/Observation.read",
            "launch/patient",
        ]);
        expect(scopes).toHaveLength(1);
        expect(scopes[0]?.resourceType).toBe("Observation");
    });

    it("throws on invalid v2 permission order", () => {
        expect(() => extractSmartFhirScopesFromTokens(["patient/Observation.dc"])).toThrow(
            "Invalid permission string dc",
        );
    });

    it("throws on invalid resource type", () => {
        expect(() => extractSmartFhirScopesFromTokens(["patient/NotARealResource.read"])).toThrow(
            "Invalid resource type NotARealResource",
        );
    });
});

describe("resolveSmartScopePrincipal", () => {
    it("prefers patient over user and system", () => {
        const scopes = extractSmartFhirScopesFromTokens(["patient/Observation.rs", "user/*.rs", "system/*.rs"]);
        expect(resolveSmartScopePrincipal(scopes)).toBe(SmartScopePrincipal.PATIENT);
    });

    it("returns user when only user scopes are present", () => {
        const scopes = extractSmartFhirScopesFromTokens(["user/Observation.rs"]);
        expect(resolveSmartScopePrincipal(scopes)).toBe(SmartScopePrincipal.USER);
    });

    it("returns system when only system scopes are present", () => {
        const scopes = extractSmartFhirScopesFromTokens(["system/*.rs"]);
        expect(resolveSmartScopePrincipal(scopes)).toBe(SmartScopePrincipal.SYSTEM);
    });

    it("returns null when no FHIR scopes are present", () => {
        expect(resolveSmartScopePrincipal(extractSmartFhirScopesFromTokens(["openid", "launch/patient"]))).toBeNull();
    });
});

describe("SmartScopeChecker wildcard resource", () => {
    it("grants READ via patient/*.read for any resource type", () => {
        const checker = new SmartScopeChecker(
            extractSmartFhirScopesFromTokens(["patient/*.read"]),
            SmartScopePrincipal.PATIENT,
        );

        expect(checker.hasPermission("Encounter", SmartScopePermission.READ)).toBe(true);
        expect(checker.hasPermission("Encounter", SmartScopePermission.SEARCH)).toBe(true);
        expect(checker.hasPermission("Encounter", SmartScopePermission.CREATE)).toBe(false);
    });
});
