/// <reference types="fhir" />

/**
 * AccessChecker 授權階段使用的同步 FHIR client。
 * 同步是 AccessChecker 契約的一部分（checkAccess / canAccess 皆為同步）；
 * 實際的 backend 查詢由 `prepare` 階段先以 AsyncFhirClientLike 取回並快取。
 * / Synchronous FHIR client consumed by access checkers.
 */
export type HttpFhirClientLike = {
    getResource: (path: string) => fhir4.Bundle;
    patchResource: (path: string, jsonPatch: string) => void | Promise<void>;
    /**
     * 選用：以 `load` 觸發的同步查詢為線索，非同步補齊 backend 回應；
     * 回傳本輪是否補到新資料。回傳 false 代表查詢集合已穩定。
     * / Optional prefetch hook: resolve the queries issued by `load` asynchronously.
     */
    warm?: (load: () => void) => Promise<boolean>;
};

/** 非同步 FHIR client；對齊 FhirBackendService，供 checker 於 prepare 階段查詢 backend。 */
export type AsyncFhirClientLike = {
    getResource: (path: string) => Promise<fhir4.Bundle>;
    patchResource: (path: string, jsonPatch: string) => Promise<void>;
};
