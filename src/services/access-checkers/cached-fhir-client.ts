/// <reference types="fhir" />

import type { AsyncFhirClientLike, HttpFhirClientLike } from "../../types/http-fhir-client";
import { normalizeFhirClientPath } from "./list-access-checker.util";

/** 查詢失敗或尚未預載時的保守回應：視為查無結果，授權一律走拒絕路徑。 */
const EMPTY_BUNDLE: fhir4.Bundle = { resourceType: "Bundle", type: "searchset", total: 0, entry: [] };

/**
 * 單輪預載同時對外發出的查詢上限。
 * 一個 transaction bundle 可以帶數百個 patient，controller 讀 request body 沒有大小上限；
 * 不設上限時單一請求就能驅動任意數量的並行 backend 請求，因此逐批消化查詢。
 */
const MAX_WARM_CONCURRENCY = 8;

/**
 * List checker 在授權階段使用的同步 FHIR client。
 *
 * `AccessChecker.checkAccess` 是同步契約，但 backend 查詢是 I/O；因此真正的請求
 * 發生在 `warm()`（由 proxy controller 於 checkAccess 前 await），同步的 `getResource`
 * 只讀取已快取的回應。未預載到的查詢在預載完成後一律視為拒絕。
 *
 * A synchronous FHIR client whose backend requests happen during the asynchronous
 * `warm()` phase; once warmed, an unresolved query fails closed.
 */
export class CachedFhirClient implements HttpFhirClientLike {
    private readonly responses = new Map<string, fhir4.Bundle>();
    private readonly unresolved = new Set<string>();
    private warmed = false;

    constructor(private readonly backend: AsyncFhirClientLike) {}

    getResource(path: string): fhir4.Bundle {
        const cached = this.responses.get(normalizeFhirClientPath(path));
        if (cached) {
            return cached;
        }

        if (this.warmed) {
            // 預載後仍查不到，代表 gateway 未能預先解析這條查詢；呼叫端一律視為拒絕。
            throw new Error(`FHIR query was not resolved before the access check: ${path}`);
        }

        this.unresolved.add(path);
        return EMPTY_BUNDLE;
    }

    patchResource(path: string, jsonPatch: string): Promise<void> {
        return this.backend.patchResource(path, jsonPatch);
    }

    /**
     * 執行 `load`（同步的授權判斷），把期間產生的查詢非同步補齊。
     * 回傳 true 代表本輪補到新資料，呼叫者需再跑一輪；false 代表查詢集合已穩定。
     */
    async warm(load: () => void): Promise<boolean> {
        if (this.warmed) {
            return false;
        }

        this.unresolved.clear();
        load();
        if (this.unresolved.size === 0) {
            this.warmed = true;
            return false;
        }

        const queries = [...this.unresolved];
        for (let start = 0; start < queries.length; start += MAX_WARM_CONCURRENCY) {
            await Promise.all(
                queries.slice(start, start + MAX_WARM_CONCURRENCY).map(async (query) => {
                    this.responses.set(normalizeFhirClientPath(query), await this.fetchBundle(query));
                }),
            );
        }
        return true;
    }

    private async fetchBundle(path: string): Promise<fhir4.Bundle> {
        try {
            return await this.backend.getResource(path);
        } catch {
            // backend 不可用時對齊「查無結果」，讓授權走拒絕路徑。
            return EMPTY_BUNDLE;
        }
    }
}
