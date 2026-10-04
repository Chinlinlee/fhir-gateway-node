/**
 * Launch context 綁定索引鍵的推導。
 *
 * **兩種 store 實作必須用同一個推導方式**——它就是 ADR-0002 那條「綁定以 `(subject, client id)`
 * 為索引鍵」的實作，而 FHIR 請求時是透過 access token 的 `jti` 走到這裡。若兩邊對鍵的認知
 * 不同，結果不是查不到而是每筆都 miss，而症狀只會是 patient／list 模式全數 401。
 */

/**
 * 分隔符；用 IdP 不會發出的控制字元，避免拼接歧義
 * （"ab"+"c" 與 "a"+"bc" 不能撞成同一筆）。
 */
const BINDING_KEY_SEPARATOR = "\u0000";

/**
 * `(subject, client id)` 的綁定鍵。
 *
 * 一位醫師同時開兩個 App、兩個不同病人是 EHR 的常態，因此這個鍵必須同時含 sub 與 client id；
 * 只用 sub 會讓兩個 App 的請求互相命中對方的病人，而且錯得沒有任何徵兆。
 *
 * 這是**粗鍵**：它只記「這組人對這個 App 目前綁到哪一位病人」，因此會被後來的 launch 移動。
 * access token 的解析不經過它（那條路徑以 launch id 指認，見 `attachAccessToken`）。
 */
export function launchContextBindingKey(subject: string, clientId: string): string {
    return `${subject}${BINDING_KEY_SEPARATOR}${clientId}`;
}
