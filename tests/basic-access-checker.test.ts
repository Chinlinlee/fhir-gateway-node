import { describe, expect, it } from "vitest";

import { AuthenticationError } from "../src/errors/authentication.error";
import {
    BasicAccessCheckerService,
    basicAccessCheckerFactory,
} from "../src/services/access-checkers/basic-access-checker.service";
import { SCOPES_CLAIM } from "../src/services/access-checkers/patient-access-checker.service";
import { PatientFinderService } from "../src/services/patient-finder.service";
import { extractSmartFhirScopesFromTokens, MergedSmartScopeChecker } from "../src/services/smart-scope.service";
import { buildFhirRequest } from "./helpers/fhir-request";

function createBasicChecker(scopesClaim: string): BasicAccessCheckerService {
    const scopes = extractSmartFhirScopesFromTokens(scopesClaim.split(/\s+/));
    return new BasicAccessCheckerService(new MergedSmartScopeChecker(scopes));
}

describe("BasicAccessCheckerService", () => {
    it("grants read when merged scopes include read from any principal", () => {
        expect(
            createBasicChecker("system/*.rs patient/Observation.crud")
                .checkAccess(buildFhirRequest("Observation/123"))
                .canAccess(),
        ).toBe(true);
    });

    it("denies read when merged scopes lack read", () => {
        expect(
            createBasicChecker("patient/Observation.c").checkAccess(buildFhirRequest("Observation/123")).canAccess(),
        ).toBe(false);
    });

    it("grants search from v1 read scope on another principal", () => {
        expect(
            createBasicChecker("user/Observation.read patient/Encounter.cr")
                .checkAccess(buildFhirRequest("Observation"))
                .canAccess(),
        ).toBe(true);
    });

    it("denies POST Patient", () => {
        expect(
            createBasicChecker("patient/Patient.cruds")
                .checkAccess(buildFhirRequest("Patient", {}, "POST", '{"resourceType":"Patient"}'))
                .canAccess(),
        ).toBe(false);
    });

    it("grants PUT Patient when update permission merged", () => {
        expect(
            createBasicChecker("system/Patient.u")
                .checkAccess(buildFhirRequest("Patient/abc", {}, "PUT", '{"resourceType":"Patient","id":"abc"}'))
                .canAccess(),
        ).toBe(true);
    });

    it("denies DELETE Patient", () => {
        expect(
            createBasicChecker("patient/Patient.cruds")
                .checkAccess(buildFhirRequest("Patient/abc", {}, "DELETE"))
                .canAccess(),
        ).toBe(false);
    });
});

describe("basicAccessCheckerFactory", () => {
    it("throws when JWT has no SMART FHIR scopes", () => {
        expect(() =>
            basicAccessCheckerFactory.create({
                jwt: {
                    payload: { [SCOPES_CLAIM]: "openid profile" },
                    protectedHeader: { alg: "RS256" },
                },
                patientFinder: PatientFinderService.getInstance(),
            }),
        ).toThrow(AuthenticationError);
    });

    it("creates checker when any principal scope is present", () => {
        const checker = basicAccessCheckerFactory.create({
            jwt: {
                payload: { [SCOPES_CLAIM]: "system/*.rs" },
                protectedHeader: { alg: "RS256" },
            },
            patientFinder: PatientFinderService.getInstance(),
        });

        expect(checker.checkAccess(buildFhirRequest("Observation/1")).canAccess()).toBe(true);
    });
});
