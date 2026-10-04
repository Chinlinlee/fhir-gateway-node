import { describe, expect, it } from "vitest";
import { DEFAULT_CLAIM_NAMES } from "../src/constants/claim-names";
import { AuthenticationError } from "../src/errors/authentication.error";
import { InvalidRequestError } from "../src/errors/invalid-request.error";
import {
    PatientAccessCheckerService,
    patientAccessCheckerFactory,
} from "../src/services/access-checkers/patient-access-checker.service";
import { PatientFinderService } from "../src/services/patient-finder.service";
import {
    extractSmartFhirScopesFromTokens,
    SmartScopeChecker,
    SmartScopePrincipal,
} from "../src/services/smart-scope.service";
import {
    DEFAULT_TEST_SCOPES_CLAIM,
    PATIENT_AUTHORIZED,
    PATIENT_NON_AUTHORIZED,
    readAccessCheckerBundleFromPatientFinder,
    readAccessCheckerFixture,
} from "./helpers/access-checker-fixture";
import { buildFhirRequest } from "./helpers/fhir-request";
import { launchContextFromClaims } from "./helpers/launch-context-fixture";

function createPatientChecker(scopesClaim = DEFAULT_TEST_SCOPES_CLAIM): PatientAccessCheckerService {
    const scopes = extractSmartFhirScopesFromTokens(scopesClaim.split(/\s+/));
    return new PatientAccessCheckerService(
        PATIENT_AUTHORIZED,
        PatientFinderService.getInstance(),
        new Map([
            [SmartScopePrincipal.PATIENT, new SmartScopeChecker(scopes, SmartScopePrincipal.PATIENT)],
            [SmartScopePrincipal.USER, new SmartScopeChecker(scopes, SmartScopePrincipal.USER)],
            [SmartScopePrincipal.SYSTEM, new SmartScopeChecker(scopes, SmartScopePrincipal.SYSTEM)],
        ]),
    );
}

function createUserScopeChecker(scopesClaim: string): PatientAccessCheckerService {
    const scopes = extractSmartFhirScopesFromTokens(scopesClaim.split(/\s+/));
    return new PatientAccessCheckerService(
        null,
        PatientFinderService.getInstance(),
        new Map([
            [SmartScopePrincipal.PATIENT, new SmartScopeChecker(scopes, SmartScopePrincipal.PATIENT)],
            [SmartScopePrincipal.USER, new SmartScopeChecker(scopes, SmartScopePrincipal.USER)],
            [SmartScopePrincipal.SYSTEM, new SmartScopeChecker(scopes, SmartScopePrincipal.SYSTEM)],
        ]),
    );
}

function bundleBody(name: string): string {
    return JSON.stringify(readAccessCheckerBundleFromPatientFinder(name));
}

describe("PatientAccessCheckerService", () => {
    it("canAccessTest", () => {
        expect(
            createPatientChecker()
                .checkAccess(buildFhirRequest(`Patient/${PATIENT_AUTHORIZED}`))
                .canAccess(),
        ).toBe(true);
    });

    it("canAccessNotAuthorized", () => {
        expect(
            createPatientChecker()
                .checkAccess(buildFhirRequest(`Patient/${PATIENT_NON_AUTHORIZED}`))
                .canAccess(),
        ).toBe(false);
    });

    it("canAccessPostPatient", () => {
        expect(
            createPatientChecker()
                .checkAccess(buildFhirRequest("Patient", {}, "POST"))
                .canAccess(),
        ).toBe(false);
    });

    it("canAccessPutPatient", () => {
        expect(
            createPatientChecker()
                .checkAccess(buildFhirRequest(`Patient/${PATIENT_AUTHORIZED}`, {}, "PUT"))
                .canAccess(),
        ).toBe(true);
    });

    it("canAccessPutUnauthorizedPatient", () => {
        expect(
            createPatientChecker()
                .checkAccess(buildFhirRequest(`Patient/${PATIENT_NON_AUTHORIZED}`, {}, "PUT"))
                .canAccess(),
        ).toBe(false);
    });

    it("canAccessSearchQuery", () => {
        expect(
            createPatientChecker()
                .checkAccess(buildFhirRequest("Observation", { subject: [PATIENT_AUTHORIZED] }))
                .canAccess(),
        ).toBe(true);
    });

    it("canAccessPostObservation", () => {
        expect(
            createPatientChecker()
                .checkAccess(buildFhirRequest("Observation", {}, "POST", readAccessCheckerFixture("test_obs.json")))
                .canAccess(),
        ).toBe(true);
    });

    it("canAccessPutObservation", () => {
        expect(
            createPatientChecker()
                .checkAccess(
                    buildFhirRequest(
                        "Observation",
                        { subject: [PATIENT_AUTHORIZED] },
                        "PUT",
                        readAccessCheckerFixture("test_obs.json"),
                    ),
                )
                .canAccess(),
        ).toBe(true);
    });

    it("canAccessPutObservationUnauthorized", () => {
        expect(() =>
            createPatientChecker()
                .checkAccess(
                    buildFhirRequest("Observation", {}, "PUT", readAccessCheckerFixture("test_obs_unauthorized.json")),
                )
                .canAccess(),
        ).toThrow(InvalidRequestError);
    });

    it("canAccessPatchObservation", () => {
        expect(
            createPatientChecker()
                .checkAccess(
                    buildFhirRequest(
                        "Observation",
                        { subject: [PATIENT_AUTHORIZED] },
                        "PATCH",
                        readAccessCheckerFixture("test_obs_patch.json"),
                    ),
                )
                .canAccess(),
        ).toBe(true);
    });

    it("canAccessPatchObservationNoReferenceAuthorized", () => {
        expect(
            createPatientChecker()
                .checkAccess(
                    buildFhirRequest(
                        "Observation",
                        { subject: [PATIENT_AUTHORIZED] },
                        "PATCH",
                        readAccessCheckerFixture("test_obs_patch_no_reference.json"),
                    ),
                )
                .canAccess(),
        ).toBe(true);
    });

    it("canAccessBundleGetNonPatientUnauthorized", () => {
        expect(
            createPatientChecker()
                .checkAccess(
                    buildFhirRequest(
                        "",
                        {},
                        "POST",
                        bundleBody("bundle_transaction_get_non_patient_unauthorized.json"),
                    ),
                )
                .canAccess(),
        ).toBe(false);
    });

    it("canAccessBundlePostPatientUnAuthorized", () => {
        expect(
            createPatientChecker()
                .checkAccess(buildFhirRequest("", {}, "POST", bundleBody("bundle_transaction_post_patient.json")))
                .canAccess(),
        ).toBe(false);
    });

    it("canAccessBundleDeletePatientUnAuthorized", () => {
        expect(
            createPatientChecker()
                .checkAccess(buildFhirRequest("", {}, "POST", bundleBody("bundle_transaction_delete_patient.json")))
                .canAccess(),
        ).toBe(false);
    });

    it("canAccessPatchObservationUnauthorizedPatient", () => {
        expect(
            createPatientChecker()
                .checkAccess(
                    buildFhirRequest(
                        "Observation",
                        { subject: [PATIENT_AUTHORIZED] },
                        "PATCH",
                        readAccessCheckerFixture("test_obs_patch_unauthorized_patient.json"),
                    ),
                )
                .canAccess(),
        ).toBe(false);
    });

    it("canAccessDeletePatientUnauthorized", () => {
        expect(
            createPatientChecker()
                .checkAccess(buildFhirRequest("Patient", {}, "DELETE"))
                .canAccess(),
        ).toBe(false);
    });

    it("canAccessDeleteObservationAuthorized", () => {
        expect(
            createPatientChecker()
                .checkAccess(buildFhirRequest("Observation", { subject: [PATIENT_AUTHORIZED] }, "DELETE"))
                .canAccess(),
        ).toBe(true);
    });

    it("canAccessPatchObservationNoValidPermissionForPatient", () => {
        expect(
            createPatientChecker("patient/Patient.write patient/Observation.read")
                .checkAccess(
                    buildFhirRequest(
                        "Observation",
                        { subject: [PATIENT_AUTHORIZED] },
                        "PATCH",
                        readAccessCheckerFixture("test_obs_patch.json"),
                    ),
                )
                .canAccess(),
        ).toBe(false);
    });

    it("canAccessPutObservationInvalidPermissionScope", () => {
        expect(() =>
            createPatientChecker("patient/Observation.invalid")
                .checkAccess(
                    buildFhirRequest("Observation", {}, "PUT", readAccessCheckerFixture("test_obs_unauthorized.json")),
                )
                .canAccess(),
        ).toThrow(InvalidRequestError);
    });

    it("canAccessBundlePutPatient", () => {
        expect(
            createPatientChecker()
                .checkAccess(
                    buildFhirRequest("", {}, "POST", bundleBody("bundle_transaction_put_authorized_patient.json")),
                )
                .canAccess(),
        ).toBe(true);
    });

    it("canAccessDeleteObservationUnauthorized", () => {
        expect(
            createPatientChecker()
                .checkAccess(buildFhirRequest("Observation", { subject: [PATIENT_NON_AUTHORIZED] }, "DELETE"))
                .canAccess(),
        ).toBe(false);
    });

    it("canAccessBundlePutPatientNoValidPermission", () => {
        expect(
            createPatientChecker("patient/Observation.*")
                .checkAccess(
                    buildFhirRequest("", {}, "POST", bundleBody("bundle_transaction_put_authorized_patient.json")),
                )
                .canAccess(),
        ).toBe(false);
    });

    it("canAccessBundlePatchResources", () => {
        expect(
            createPatientChecker()
                .checkAccess(buildFhirRequest("", {}, "POST", bundleBody("bundle_transaction_patch_authorized.json")))
                .canAccess(),
        ).toBe(true);
    });

    it("canAccessBundlePatchResourcesNoValidPermission", () => {
        expect(
            createPatientChecker("patient/Observation.*")
                .checkAccess(buildFhirRequest("", {}, "POST", bundleBody("bundle_transaction_patch_authorized.json")))
                .canAccess(),
        ).toBe(false);
    });

    it("canAccessBundleSearchResources", () => {
        expect(
            createPatientChecker()
                .checkAccess(
                    buildFhirRequest("", {}, "POST", bundleBody("bundle_transaction_get_non_patient_authorized.json")),
                )
                .canAccess(),
        ).toBe(true);
    });

    it("canAccessBundleSearchResourcesNoValidPermission", () => {
        expect(
            createPatientChecker("patient/Observation.*")
                .checkAccess(
                    buildFhirRequest("", {}, "POST", bundleBody("bundle_transaction_get_non_patient_authorized.json")),
                )
                .canAccess(),
        ).toBe(false);
    });

    it("canAccessGetObservationMultipleSubjectsUnauthorized", () => {
        expect(
            createPatientChecker()
                .checkAccess(
                    buildFhirRequest("Observation", {
                        subject: [`${PATIENT_AUTHORIZED},${PATIENT_NON_AUTHORIZED}`],
                    }),
                )
                .canAccess(),
        ).toBe(false);
    });

    it("uses patient claim not patient_id", () => {
        expect(DEFAULT_CLAIM_NAMES.patient).toBe("patient");
        expect(DEFAULT_CLAIM_NAMES.scopesSpaceDelimited).toBe("scope");
    });

    it("factory accepts user scopes without patient claim", () => {
        const checker = patientAccessCheckerFactory.create({
            launch: launchContextFromClaims({ scope: "user/Observation.rs" }),
            patientFinder: PatientFinderService.getInstance(),
        });

        expect(
            checker.checkAccess(buildFhirRequest("Observation", { subject: [PATIENT_NON_AUTHORIZED] })).canAccess(),
        ).toBe(true);
    });

    it("factory accepts system scopes without patient claim", () => {
        const checker = patientAccessCheckerFactory.create({
            launch: launchContextFromClaims({ scope: "system/*.rs" }),
            patientFinder: PatientFinderService.getInstance(),
        });

        expect(checker.checkAccess(buildFhirRequest("Observation")).canAccess()).toBe(true);
    });

    it("factory still requires patient claim for patient scopes", () => {
        expect(() =>
            patientAccessCheckerFactory.create({
                launch: launchContextFromClaims({ scope: "patient/Observation.rs" }),
                patientFinder: PatientFinderService.getInstance(),
            }),
        ).toThrow(AuthenticationError);
    });

    it("user scopes skip patient compartment restriction", () => {
        expect(
            createUserScopeChecker("user/Observation.rs")
                .checkAccess(buildFhirRequest(`Patient/${PATIENT_NON_AUTHORIZED}`))
                .canAccess(),
        ).toBe(false);

        expect(
            createUserScopeChecker("user/*.rs")
                .checkAccess(buildFhirRequest(`Patient/${PATIENT_NON_AUTHORIZED}`))
                .canAccess(),
        ).toBe(true);
    });
});
