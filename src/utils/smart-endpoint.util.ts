/**
 * gateway 對外的 SMART 端點 URL 一律由設定的 public base URL 組出來。
 *
 * 絕不從請求的 `Host` header 推導：那個 header 由呼叫端控制，拿它改寫端點等於讓任何人都能
 * 把 SMART App 的 code exchange 導到自己的主機（ADR-0002：端點改寫要有一個權威來源）。
 */
export function smartEndpointUrl(publicBaseUrl: string, path: string): string {
    const base = publicBaseUrl.endsWith("/") ? publicBaseUrl.slice(0, -1) : publicBaseUrl;
    return `${base}${path}`;
}
