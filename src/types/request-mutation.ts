/** 轉發前對 query 的變更；對齊 Java RequestMutation。 */
export type RequestMutation = {
    /** 新增或覆寫 param（同名時以 mutation 值為準）。 */
    additionalQueryParams?: Record<string, string[]>;
    /** 轉發前移除的 param 名稱。 */
    discardQueryParams?: string[];
};

export function emptyRequestMutation(): RequestMutation {
    return {
        additionalQueryParams: {},
        discardQueryParams: [],
    };
}
