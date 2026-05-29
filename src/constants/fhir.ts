/** FHIR version fixed to R4 / 與原版一致，暫不支援可配置版本 */
export const FHIR_VERSION = "R4" as const;

/**
 * Search modifiers blocked for ACL safety (PatientFinder blockJoins).
 * 封鎖 chaining / _has / _include / _revinclude，避免繞過 patient context。
 */
export const BLOCKED_SEARCH_MODIFIERS = ["_has", "_include", "_revinclude"] as const;

/** Chaining uses dot in param name e.g. subject.name — checked separately in PatientFinder */
export const CHAINING_PARAM_PATTERN = /\./;
