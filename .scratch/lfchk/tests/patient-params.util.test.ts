import { describe, expect, it } from "vitest";

import { getPrimaryPatientSearchParam } from "../src/utils/patient-params.util";

describe("getPrimaryPatientSearchParam", () => {
    it("returns patient for Encounter", () => {
        expect(getPrimaryPatientSearchParam("Encounter")).toBe("patient");
    });

    it("returns patient for Observation when listed in compartment", () => {
        expect(getPrimaryPatientSearchParam("Observation")).toBe("patient");
    });

    it("returns subject when resource has no patient param", () => {
        expect(getPrimaryPatientSearchParam("DiagnosticReport")).toBe("subject");
    });
});
