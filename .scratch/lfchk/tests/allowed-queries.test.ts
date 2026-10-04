import { describe, expect, it } from "vitest";

import { AllowedQueriesCheckerService, AllowedQueriesConfigError } from "../src/services/allowed-queries.service";
import { allowedQueriesFixturePath } from "./helpers/allowed-queries-fixture";
import { buildFhirRequest } from "./helpers/fhir-request";

describe("AllowedQueriesCheckerService", () => {
    it("validGetPagesQuery", () => {
        const checker = AllowedQueriesCheckerService.loadFromFile(
            allowedQueriesFixturePath("hapi_page_url_allowed_queries.json"),
        );
        const request = buildFhirRequest("", { _getpages: "A_PAGE_ID" });
        expect(checker.checkAccess(request).canAccess()).toBe(true);
    });

    it("validGetPagesQueryExtraValue", () => {
        const checker = AllowedQueriesCheckerService.loadFromFile(
            allowedQueriesFixturePath("hapi_page_url_allowed_queries.json"),
        );
        const request = buildFhirRequest("", {
            _getpages: ["A_PAGE_ID", "A_SECOND_ID"],
        });
        expect(checker.checkAccess(request).canAccess()).toBe(true);
    });

    it("validGetPagesQueryExtraParam", () => {
        const checker = AllowedQueriesCheckerService.loadFromFile(
            allowedQueriesFixturePath("hapi_page_url_allowed_queries.json"),
        );
        const request = buildFhirRequest("", {
            _getpages: "A_PAGE_ID",
            another_param: "SOMETHING",
        });
        expect(checker.checkAccess(request).canAccess()).toBe(true);
    });

    it("validUnAuthenticatedQuery", () => {
        const checker = AllowedQueriesCheckerService.loadFromFile(
            allowedQueriesFixturePath("allowed_unauthenticated_queries.json"),
        );
        const request = buildFhirRequest("Composition");
        expect(checker.checkUnAuthenticatedAccess(request).canAccess()).toBe(true);
    });

    it("validExactPathMatch", () => {
        const checker = AllowedQueriesCheckerService.loadFromFile(
            allowedQueriesFixturePath("allowed_queries_with_path_type.json"),
        );
        const request = buildFhirRequest("Observation");
        expect(checker.checkAccess(request).canAccess()).toBe(true);
    });

    it("validPathWithVariableAnyParamValueMatch", () => {
        const checker = AllowedQueriesCheckerService.loadFromFile(
            allowedQueriesFixturePath("allowed_queries_with_path_type.json"),
        );
        const request = buildFhirRequest("Composition/233");
        expect(checker.checkAccess(request).canAccess()).toBe(true);
    });

    it("validBasePathAnyParamValueMatch", () => {
        const checker = AllowedQueriesCheckerService.loadFromFile(
            allowedQueriesFixturePath("allowed_queries_with_path_type.json"),
        );
        const request = buildFhirRequest("Composition");
        expect(checker.checkAccess(request).canAccess()).toBe(true);
    });

    it("validRequestTypeMatch", () => {
        const checker = AllowedQueriesCheckerService.loadFromFile(
            allowedQueriesFixturePath("allowed_queries_with_path_type.json"),
        );
        const request = buildFhirRequest("Encounter", {}, "GET");
        expect(checker.checkAccess(request).canAccess()).toBe(true);
    });

    it("noMatchForObservationQuery", () => {
        const checker = AllowedQueriesCheckerService.loadFromFile(
            allowedQueriesFixturePath("hapi_page_url_allowed_queries.json"),
        );
        const request = buildFhirRequest("/Observation");
        expect(checker.checkAccess(request).canAccess()).toBe(false);
    });

    it("configNullPath", () => {
        expect(() =>
            AllowedQueriesCheckerService.loadFromFile(allowedQueriesFixturePath("no_path_allowed_queries.json")),
        ).toThrow(AllowedQueriesConfigError);
    });

    it("malformedConfig", () => {
        expect(() =>
            AllowedQueriesCheckerService.loadFromFile(allowedQueriesFixturePath("malformed_allowed_queries.json")),
        ).toThrow(AllowedQueriesConfigError);
    });

    it("denyGetPagesQueryExtraParam", () => {
        const checker = AllowedQueriesCheckerService.loadFromFile(
            allowedQueriesFixturePath("allowed_queries_with_no_extra_params.json"),
        );
        const request = buildFhirRequest("", {
            _getpages: "A_PAGE_ID",
            another_param: "SOMETHING",
        });
        expect(checker.checkAccess(request).canAccess()).toBe(false);
    });

    it("denyQueryWithoutRequiredParam", () => {
        const checker = AllowedQueriesCheckerService.loadFromFile(
            allowedQueriesFixturePath("hapi_page_url_allowed_queries.json"),
        );
        const request = buildFhirRequest("", { another_param: "SOMETHING" });
        expect(checker.checkAccess(request).canAccess()).toBe(false);
    });

    it("denyUnAuthenticatedQuery", () => {
        const checker = AllowedQueriesCheckerService.loadFromFile(
            allowedQueriesFixturePath("allowed_unauthenticated_queries.json"),
        );
        const request = buildFhirRequest("Patient");
        expect(checker.checkUnAuthenticatedAccess(request).canAccess()).toBe(false);
    });

    it("denyPathMisMatch", () => {
        const checker = AllowedQueriesCheckerService.loadFromFile(
            allowedQueriesFixturePath("allowed_queries_with_path_type.json"),
        );
        const request = buildFhirRequest("Patient");
        expect(checker.checkAccess(request).canAccess()).toBe(false);
    });

    it("denyRequestTypeMisMatch", () => {
        const checker = AllowedQueriesCheckerService.loadFromFile(
            allowedQueriesFixturePath("allowed_queries_with_path_type.json"),
        );
        const request = buildFhirRequest("Encounter", {}, "POST");
        expect(checker.checkAccess(request).canAccess()).toBe(false);
    });

    it("loadFromFile without path — checker disabled", () => {
        const checker = AllowedQueriesCheckerService.loadFromFile(undefined);
        expect(checker.isEnabled()).toBe(false);
        const request = buildFhirRequest("", { _getpages: "A_PAGE_ID" });
        expect(checker.checkAccess(request).canAccess()).toBe(false);
    });
});
