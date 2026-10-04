/**
 * 寬鬆地把字串讀成 JSON。
 *
 * 呼叫端拿到的是 `unknown` 而不是拋錯：這裡的兩處來源都是「不保證是 JSON」的外部輸入
 * （IdP 的 token 端點回應、token request body），它們各自已經用 zod 或明確的型別檢查決定
 * 怎麼處理「讀不出來」這種情形。解析本身不需要第三種結果。
 *
 * Parses JSON leniently; the caller decides what an unparsable body means.
 */
export function parseJson(body: string): unknown {
    try {
        return JSON.parse(body) as unknown;
    } catch {
        return undefined;
    }
}
