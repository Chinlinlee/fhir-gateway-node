import { beforeEach, describe, expect, it } from "vitest";

import { InvalidRequestError } from "../src/errors/invalid-request.error";
import { ListAccessCheckerService } from "../src/services/access-checkers/list-access-checker.service";
import {
    buildListSearchPath,
    buildPatientExistenceSearchPath,
} from "../src/services/access-checkers/list-access-checker.util";
import { PatientFinderService } from "../src/services/patient-finder.service";
import {
    PATIENT_AUTHORIZED,
    PATIENT_IN_BUNDLE_1,
    PATIENT_IN_BUNDLE_2,
    PATIENT_NON_AUTHORIZED,
    TEST_LIST_ID,
    readAccessCheckerBundleFromPatientFinder,
    readAccessCheckerFixture,
    readAccessCheckerJson,
} from "./helpers/access-checker-fixture";
import { buildFhirRequest } from "./helpers/fhir-request";
import { MockHttpFhirClient } from "./helpers/mock-http-fhir-client";

function createListChecker(mock: MockHttpFhirClient): ListAccessCheckerService {
    return new ListAccessCheckerService(mock, TEST_LIST_ID, PatientFinderService.getInstance());
}

function registerListSearch(mock: MockHttpFhirClient, itemParam: string, fixtureName: string): void {
    mock.registerGet(buildListSearchPath(TEST_LIST_ID, itemParam), readAccessCheckerJson<fhir4.Bundle>(fixtureName));
}

function registerPatientSearch(mock: MockHttpFhirClient, patientId: string, fixtureName: string): void {
    mock.registerGet(buildPatientExistenceSearchPath(patientId), readAccessCheckerJson<fhir4.Bundle>(fixtureName));
}

function bundleFixture(name: string): string {
    return JSON.stringify(readAccessCheckerBundleFromPatientFinder(name));
}

describe("ListAccessCheckerService", () => {
    let mockClient: MockHttpFhirClient;
    let checker: ListAccessCheckerService;

    beforeEach(() => {
        mockClient = new MockHttpFhirClient();
        registerListSearch(mockClient, `item=Patient%2F${PATIENT_AUTHORIZED}`, "bundle_list_patient_item.json");
        registerListSearch(mockClient, `item=Patient%2F${PATIENT_NON_AUTHORIZED}`, "bundle_empty.json");
        checker = createListChecker(mockClient);
    });

    it("createTest", () => {
        expect(checker).toBeDefined();
    });

    it("canAccessList", () => {
        expect(checker.checkAccess(buildFhirRequest(`List/${TEST_LIST_ID}`)).canAccess()).toBe(true);
    });

    it("canAccessListNotAuthorized", () => {
        expect(checker.checkAccess(buildFhirRequest("List/wrong-id")).canAccess()).toBe(false);
    });

    it("canAccessTest", () => {
        expect(checker.checkAccess(buildFhirRequest(`Patient/${PATIENT_AUTHORIZED}`)).canAccess()).toBe(true);
    });

    it("canAccessNotAuthorized", () => {
        expect(checker.checkAccess(buildFhirRequest(`Patient/${PATIENT_NON_AUTHORIZED}`)).canAccess()).toBe(false);
    });

    it("canAccessDirectResourceNotAuthorized", () => {
        expect(checker.checkAccess(buildFhirRequest("Observation/a-random-id")).canAccess()).toBe(false);
    });

    it("canAccessSearchQuery", () => {
        expect(
            checker.checkAccess(buildFhirRequest("Observation", { subject: [PATIENT_AUTHORIZED] })).canAccess(),
        ).toBe(true);
    });

    it("canAccessSearchQueryNotAuthorized", () => {
        expect(() => checker.checkAccess(buildFhirRequest("Observation"))).toThrow(InvalidRequestError);
    });

    it("canAccessPostObservationWithPerformer", () => {
        registerListSearch(
            mockClient,
            `item=Patient%2F${PATIENT_AUTHORIZED}%2CPatient%2Ftest-patient-1%2CPatient%2Ftest-patient-2`,
            "bundle_list_patient_item.json",
        );
        expect(
            checker
                .checkAccess(
                    buildFhirRequest("Observation", {}, "POST", readAccessCheckerFixture("test_obs_performers.json")),
                )
                .canAccess(),
        ).toBe(true);
    });

    it("canAccessPostPatient", () => {
        const decision = checker.checkAccess(buildFhirRequest("Patient", {}, "POST"));
        expect(decision.canAccess()).toBe(true);
        expect(decision.postProcess).toBeDefined();
    });

    it("canAccessPutExistingPatient", () => {
        registerPatientSearch(mockClient, PATIENT_AUTHORIZED, "patient_id_search_single.json");
        expect(checker.checkAccess(buildFhirRequest(`Patient/${PATIENT_AUTHORIZED}`, {}, "PUT")).canAccess()).toBe(
            true,
        );
    });

    it("canAccessPatientWithMultipleIdSearch", () => {
        registerListSearch(
            mockClient,
            `item=Patient%2F${PATIENT_IN_BUNDLE_1}&item=Patient%2F${PATIENT_AUTHORIZED}`,
            "bundle_list_patient_item.json",
        );
        expect(
            checker
                .checkAccess(buildFhirRequest("Patient", { _id: [`${PATIENT_AUTHORIZED},${PATIENT_IN_BUNDLE_1}`] }))
                .canAccess(),
        ).toBe(true);
    });

    it("canAccessPatientWithMultipleIdSearchUnauthorized", () => {
        registerListSearch(
            mockClient,
            `item=Patient%2F${PATIENT_NON_AUTHORIZED}&item=Patient%2F${PATIENT_AUTHORIZED}`,
            "bundle_empty.json",
        );
        expect(
            checker
                .checkAccess(buildFhirRequest("Patient", { _id: [`${PATIENT_AUTHORIZED},${PATIENT_NON_AUTHORIZED}`] }))
                .canAccess(),
        ).toBe(false);
    });

    it("canAccessGetObservations", () => {
        registerPatientSearch(mockClient, PATIENT_AUTHORIZED, "patient_id_search_single.json");
        registerPatientSearch(mockClient, PATIENT_IN_BUNDLE_1, "patient_id_search_single.json");
        registerListSearch(
            mockClient,
            `item=Patient%2F${PATIENT_IN_BUNDLE_1}&item=Patient%2F${PATIENT_AUTHORIZED}`,
            "bundle_list_patient_item.json",
        );
        expect(
            checker
                .checkAccess(
                    buildFhirRequest("Observation", { subject: [`${PATIENT_AUTHORIZED},${PATIENT_IN_BUNDLE_1}`] }),
                )
                .canAccess(),
        ).toBe(true);
    });

    it("canAccessPutNewPatient", () => {
        registerPatientSearch(mockClient, PATIENT_AUTHORIZED, "bundle_empty.json");
        expect(checker.checkAccess(buildFhirRequest(`Patient/${PATIENT_AUTHORIZED}`, {}, "PUT")).canAccess()).toBe(
            true,
        );
    });

    it("canAccessBundleGetNonPatientUnAuthorized", () => {
        registerListSearch(mockClient, `item=Patient%2F${PATIENT_IN_BUNDLE_2}`, "bundle_empty.json");
        expect(
            checker
                .checkAccess(
                    buildFhirRequest(
                        "",
                        {},
                        "POST",
                        bundleFixture("bundle_transaction_get_non_patient_unauthorized.json"),
                    ),
                )
                .canAccess(),
        ).toBe(false);
    });

    it("canAccessBundleGetNonPatientAuthorized", () => {
        registerPatientSearch(mockClient, PATIENT_AUTHORIZED, "patient_id_search_single.json");
        registerPatientSearch(mockClient, PATIENT_IN_BUNDLE_1, "patient_id_search_single.json");
        registerListSearch(
            mockClient,
            `item=Patient%2F${PATIENT_IN_BUNDLE_1}&item=Patient%2F${PATIENT_AUTHORIZED}`,
            "bundle_list_patient_item.json",
        );
        expect(
            checker
                .checkAccess(
                    buildFhirRequest(
                        "",
                        {},
                        "POST",
                        bundleFixture("bundle_transaction_get_non_patient_multiple_authorized.json"),
                    ),
                )
                .canAccess(),
        ).toBe(true);
    });

    it("canAccessBundleGetPatientNonAuthorized", () => {
        registerListSearch(mockClient, `item=Patient%2F${PATIENT_IN_BUNDLE_2}`, "bundle_empty.json");
        expect(() =>
            checker.checkAccess(
                buildFhirRequest("", {}, "POST", bundleFixture("bundle_transaction_get_patient_unauthorized.json")),
            ),
        ).toThrow(InvalidRequestError);
    });

    it("canAccessBundlePutExistingPatient", () => {
        registerPatientSearch(mockClient, PATIENT_AUTHORIZED, "patient_id_search_single.json");
        registerPatientSearch(mockClient, PATIENT_IN_BUNDLE_1, "patient_id_search_single.json");
        registerListSearch(
            mockClient,
            `item=Patient%2F${PATIENT_IN_BUNDLE_1}&item=Patient%2F${PATIENT_AUTHORIZED}`,
            "bundle_list_patient_item.json",
        );
        expect(
            checker
                .checkAccess(buildFhirRequest("", {}, "POST", bundleFixture("bundle_transaction_put_patient.json")))
                .canAccess(),
        ).toBe(true);
    });

    it("canAccessBundlePutNewPatient", () => {
        registerPatientSearch(mockClient, PATIENT_AUTHORIZED, "bundle_empty.json");
        registerPatientSearch(mockClient, PATIENT_IN_BUNDLE_1, "patient_id_search_single.json");
        registerListSearch(mockClient, `item=Patient%2F${PATIENT_IN_BUNDLE_1}`, "bundle_list_patient_item.json");
        expect(
            checker
                .checkAccess(buildFhirRequest("", {}, "POST", bundleFixture("bundle_transaction_put_patient.json")))
                .canAccess(),
        ).toBe(true);
    });

    it("canAccessBundlePutExistingPatientUnauthorized", () => {
        registerListSearch(mockClient, `item=Patient%2F${PATIENT_NON_AUTHORIZED}`, "bundle_empty.json");
        registerPatientSearch(mockClient, PATIENT_NON_AUTHORIZED, "bundle_list_patient_item.json");
        expect(
            checker
                .checkAccess(
                    buildFhirRequest("", {}, "POST", bundleFixture("bundle_transaction_put_unauthorized.json")),
                )
                .canAccess(),
        ).toBe(false);
    });

    it("canAccessBundleNonPatientResourcesUnauthorized", () => {
        expect(() =>
            checker.checkAccess(
                buildFhirRequest("", {}, "POST", bundleFixture("bundle_transaction_no_patient_in_url.json")),
            ),
        ).toThrow(InvalidRequestError);
    });

    it("canAccessBundleNonPatientResourcesAndNewPatient", () => {
        registerListSearch(
            mockClient,
            `item=Patient%2F${PATIENT_IN_BUNDLE_1}&item=Patient%2F${PATIENT_IN_BUNDLE_1}%2CPatient%2F${PATIENT_AUTHORIZED}`,
            "bundle_list_patient_item.json",
        );
        registerPatientSearch(mockClient, PATIENT_IN_BUNDLE_2, "bundle_empty.json");
        expect(
            checker
                .checkAccess(
                    buildFhirRequest("", {}, "POST", bundleFixture("bundle_transaction_patient_and_non_patients.json")),
                )
                .canAccess(),
        ).toBe(true);
    });

    it("canAccessBundlePatchUnauthorized", () => {
        registerPatientSearch(mockClient, PATIENT_AUTHORIZED, "bundle_list_patient_item.json");
        registerListSearch(
            mockClient,
            `item=Patient%2Fmichael%2CPatient%2Fbob&item=Patient%2F${PATIENT_IN_BUNDLE_1}&item=Patient%2F${PATIENT_AUTHORIZED}`,
            "bundle_empty.json",
        );
        expect(
            checker
                .checkAccess(
                    buildFhirRequest("", {}, "POST", bundleFixture("bundle_transaction_patch_unauthorized.json")),
                )
                .canAccess(),
        ).toBe(false);
    });

    it("canAccessBundlePostPatient", () => {
        expect(
            checker
                .checkAccess(buildFhirRequest("", {}, "POST", bundleFixture("bundle_transaction_post_patient.json")))
                .canAccess(),
        ).toBe(true);
    });

    it("canAccessBundleDeletePatient", () => {
        expect(
            checker
                .checkAccess(buildFhirRequest("", {}, "POST", bundleFixture("bundle_transaction_delete_patient.json")))
                .canAccess(),
        ).toBe(true);
    });

    it("canAccessBundleDeleteMultiplePatients", () => {
        registerListSearch(
            mockClient,
            `item=Patient%2F${PATIENT_IN_BUNDLE_1}&item=Patient%2F${PATIENT_AUTHORIZED}`,
            "bundle_list_patient_item.json",
        );
        expect(
            checker
                .checkAccess(
                    buildFhirRequest("", {}, "POST", bundleFixture("bundle_transaction_delete_multiple_patient.json")),
                )
                .canAccess(),
        ).toBe(true);
    });

    it("canAccessPatchObservationUnauthorizedPatient", () => {
        registerListSearch(
            mockClient,
            `item=Patient%2Fmichael%2CPatient%2Fbob&item=Patient%2F${PATIENT_AUTHORIZED}`,
            "bundle_empty.json",
        );
        expect(
            checker
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

    it("canAccessDeletePatient", () => {
        expect(checker.checkAccess(buildFhirRequest(`Patient/${PATIENT_AUTHORIZED}`, {}, "DELETE")).canAccess()).toBe(
            true,
        );
    });

    it("canAccessDeletePatientUnauthorized", () => {
        expect(
            checker.checkAccess(buildFhirRequest(`Patient/${PATIENT_NON_AUTHORIZED}`, {}, "DELETE")).canAccess(),
        ).toBe(false);
    });

    it("canAccessDeleteAccessListUnauthorized", () => {
        expect(checker.checkAccess(buildFhirRequest(`List/${TEST_LIST_ID}`, {}, "DELETE")).canAccess()).toBe(false);
    });

    it("canAccessDeleteObservation", () => {
        expect(
            checker
                .checkAccess(buildFhirRequest("Observation", { subject: [PATIENT_AUTHORIZED] }, "DELETE"))
                .canAccess(),
        ).toBe(true);
    });

    it("canAccessDeleteObservationsForMultiplePatients", () => {
        registerPatientSearch(mockClient, PATIENT_AUTHORIZED, "patient_id_search_single.json");
        registerPatientSearch(mockClient, PATIENT_IN_BUNDLE_1, "patient_id_search_single.json");
        registerListSearch(
            mockClient,
            `item=Patient%2F${PATIENT_IN_BUNDLE_1}&item=Patient%2F${PATIENT_AUTHORIZED}`,
            "bundle_list_patient_item.json",
        );
        expect(
            checker
                .checkAccess(
                    buildFhirRequest(
                        "Observation",
                        { subject: [`${PATIENT_AUTHORIZED},${PATIENT_IN_BUNDLE_1}`] },
                        "DELETE",
                    ),
                )
                .canAccess(),
        ).toBe(true);
    });

    it("canAccessDeleteObservationsForMultiplePatientsUnauthorized", () => {
        registerPatientSearch(mockClient, PATIENT_AUTHORIZED, "patient_id_search_single.json");
        registerPatientSearch(mockClient, PATIENT_NON_AUTHORIZED, "patient_id_search_single.json");
        registerListSearch(
            mockClient,
            `item=Patient%2F${PATIENT_NON_AUTHORIZED}&item=Patient%2F${PATIENT_AUTHORIZED}`,
            "bundle_empty.json",
        );
        expect(
            checker
                .checkAccess(
                    buildFhirRequest(
                        "Observation",
                        { subject: [`${PATIENT_NON_AUTHORIZED},${PATIENT_AUTHORIZED}`] },
                        "DELETE",
                    ),
                )
                .canAccess(),
        ).toBe(false);
    });

    it("canAccessDeleteObservationUnauthorized", () => {
        expect(
            checker
                .checkAccess(buildFhirRequest("Observation", { subject: [PATIENT_NON_AUTHORIZED] }, "DELETE"))
                .canAccess(),
        ).toBe(false);
    });
});
