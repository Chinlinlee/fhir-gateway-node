/**
 * Launch context 的共用常數。
 *
 * 放在這裡而不是各自的 store 實作裡，是因為這是**安全常數**：launch id 的長決定了它的
 * 猜測難度，in-memory 與 Valkey 兩個實作必須產生同一種強度的 handle。它們若各自寫一個
 * `32`，其中一個被改動時不會有任何測試或編譯錯誤——只會在正式環境悄悄變弱。
 *
 * Constants shared by every launch context store implementation. The launch id length is a
 * security constant: the two implementations must not drift apart.
 */

/** launch id 的位元組長度；base64url 後 43 個字元，不含任何可推導的結構。 */
export const LAUNCH_ID_BYTES = 32;
