import { describe, expect, it } from "vitest";

import { CHAINING_PARAM_PATTERN, FHIR_VERSION } from "../src/constants/fhir";
import { readResourceJson } from "../src/utils/load-resource";

describe("FHIR static resources", () => {
    it("exports R4 constant", () => {
        expect(FHIR_VERSION).toBe("R4");
    });

    it("loads CompartmentDefinition-patient.json", () => {
        const data = readResourceJson("CompartmentDefinition-patient.json");
        expect(data).toBeTypeOf("object");
    });

    it("loads patient_paths.json", () => {
        const data = readResourceJson("patient_paths.json");
        expect(data).toBeTypeOf("object");
    });

    it("loads patient_params.json", () => {
        const data = readResourceJson("patient_params.json") as Record<string, string>;
        expect(data.Encounter).toBe("patient");
        expect(data.Observation).toBe("patient");
    });

    it("loads hapi_page_url_allowed_queries.json", () => {
        const data = readResourceJson("hapi_page_url_allowed_queries.json");
        expect(data).toBeTypeOf("object");
    });

    it("detects chaining param pattern", () => {
        expect(CHAINING_PARAM_PATTERN.test("subject.name")).toBe(true);
        expect(CHAINING_PARAM_PATTERN.test("subject")).toBe(false);
    });
});
