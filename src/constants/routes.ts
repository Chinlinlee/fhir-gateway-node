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

/**
 * gateway 代理 SMART authorization flow 的前綴。放在 `/fhir` 之外：patient-facing 的 FHIR
 * proxy 是 catch-all 的 `.all("/*")`，授權流程不該混在它裡面。
 */
export const SMART_API_PREFIX = "/smart";

/** gateway 自己的 authorization endpoint；宣告在 SMART configuration 裡取代 IdP 的。 */
export const SMART_AUTHORIZE_PATH = "/authorize";

/** gateway 自己的 token endpoint；code 與 refresh 兩種 grant 都在這裡。 */
export const SMART_TOKEN_PATH = "/token";

/** gateway 自己的 callback；`redirect_uri` 被改寫到這裡，綁定點就發生在這條路徑上。 */
export const SMART_CALLBACK_PATH = "/callback";
