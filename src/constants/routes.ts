/** FHIR proxy servlet prefix (Java @WebServlet "/fhir/*"). */
export const FHIR_API_PREFIX = "/fhir";

/**
 * SMART App Launch well-known path (no JWT).
 * @see https://hl7.org/fhir/smart-app-launch/conformance.html#using-well-known
 */
export const WELL_KNOWN_SMART_CONFIGURATION_PATH = ".well-known/smart-configuration";

/**
 * 內部（EHR 面向）API 前綴；與 patient-facing 的 `/fhir` 分開，兩者不共用認證。
 * Prefix for the EHR-facing internal API, separate from the patient-facing `/fhir`.
 */
export const INTERNAL_LAUNCH_API_PREFIX = "/internal";

/** 註冊一次 launch context 的路徑（相對於 `INTERNAL_LAUNCH_API_PREFIX`）。 */
export const LAUNCH_CONTEXTS_PATH = "/launch-contexts";
