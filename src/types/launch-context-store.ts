/**
 * Launch context store 的窄介面（ADR-0002 Module 1）。
 *
 * launch context 歸 gateway 所有：EHR 先建立一份尚未綁定到任何使用者的 context，
 * gateway 生成 opaque 的 launch id 交給 EHR；使用者完成認證的那一刻（authorization flow 的
 * callback）才把 launch id 綁到 `(subject, client id)`，之後每一次 FHIR 存取都依這組鍵回讀。
 *
 * 介面刻意維持窄：建立未綁定、依 launch id 查可用性、綁定到 `(subject, client id)`、
 * 把這次授權發出去的 access token 接上綁定、依 access token 回讀、刪除。
 *
 * **為什麼 FHIR 請求時是依 access token 回讀，而不是直接用 `(subject, client id)`：**
 * code exchange 是 gateway 用自己的 IdP client 憑證做的，因此 IdP 簽出的 access token 的
 * `azp` 是 **gateway 的** client id，不是 App 的——token 裡沒有任何欄位指出這次授權屬於哪個
 * App。（ADR-0002 原本假設 `azp` 是 App 的，那個假設在 gateway 代理流程下不成立。）
 * 唯一能指認「這張具體的 token」的 claim 是 `jti`，而 gateway 正是發出這張 token 給 App 的
 * 那一邊，因此把 access token 接上綁定是唯一不會讓「同一位醫師同時開兩個 App、兩個不同病人」
 * 互相撞到的做法。refresh 換發新 token 時同樣接上同一筆綁定。
 *
 * `authorize` 在轉發給 IdP 之前必須先確認 launch id 真的存在且還沒被綁走，因此介面需要
 * 依 launch id 查一次；這與 `bind` 是兩件事：查詢不改變任何狀態。
 *
 * Narrow store seam: create an unbound context, look it up by launch id, bind it to
 * `(subject, client id)`, attach an issued access token to that binding, read it back by
 * that token, delete it. Nothing else belongs here.
 */
export type LaunchContextStore = {
    /**
     * 建立一份尚未綁定到任何使用者的 launch context，並回傳 gateway 生成的 opaque launch id
     * 與它的到期時間。未綁定的 context 有自己的短 TTL，過期後視為不存在。
     */
    create: (input: CreateLaunchContextInput) => Promise<CreatedLaunchContext>;

    /**
     * 這個 launch id 現在能不能拿來授權：存在、尚未被綁定、且未過期。
     *
     * 這是唯讀的檢查，`authorize` 在轉發之前用它擋掉未知或已用過的 launch id——
     * 擋掉之後 IdP 完全不知道這次 launch 的存在，也不會去困惑。
     */
    isAvailable: (launchId: string) => Promise<boolean>;
    /**
     * 把 launch id 綁到 `(subject, client id)`。已綁定的 launch id 不可重複綁定，
     * 既有綁定不會被覆寫。
     *
     * 回傳 `undefined` 的三種情形對呼叫端是同一件事——這個 launch id 不存在：
     * 未知 id、已過期、已被綁定過。
     */
    bind: (launchId: string, subject: string, clientId: string) => Promise<BoundLaunchContext | undefined>;

    /**
     * 把這次授權即將交給 App 的那張 access token（以 IdP 的 `jti` 指認）接上它所屬的綁定。
     *
     * 由 token endpoint 在**即將把 token 交給 App 的那一刻**呼叫：在此之前這張 token 還沒到
     * App 手裡，先接上只會留下一筆沒人用得到的索引。`(subject, client id)` 上沒有綁定時
     * 什麼都不做——沒有綁定的 access token 在授權層本來就會被拒絕。
     */
    attachAccessToken: (tokenId: string, subject: string, clientId: string) => Promise<void>;

    /**
     * 依 App 帶來的 access token（JWT `jti`）回讀綁定後的 launch context；查無回傳 `undefined`。
     * 綁定被刪除後，一併指向它的 access token 也查不到。
     */
    getByAccessToken: (tokenId: string) => Promise<BoundLaunchContext | undefined>;

    /** 依 `(subject, client id)` 回讀綁定後的 launch context；查無回傳 `undefined`。 */
    get: (subject: string, clientId: string) => Promise<BoundLaunchContext | undefined>;

    /** 刪除 `(subject, client id)` 的綁定；原本沒有綁定時回傳 `false`。 */
    delete: (subject: string, clientId: string) => Promise<boolean>;
};

/** EHR 註冊一次 launch 時送進來的內容；patient 與 patient list 二擇一，就診選填。 */
export type CreateLaunchContextInput = {
    /** 未綁定 launch context 的存活秒數；由呼叫端自設定來源決定。 */
    ttlSeconds: number;
    /** 就診參照；patient 與 patient list 兩種 launch 都可能帶。 */
    encounterId?: string;
} & ({ patientId: string; patientListId?: never } | { patientListId: string; patientId?: never });

/** 建立成功後交給 EHR 的 launch id 與它的有效期。 */
export type CreatedLaunchContext = {
    /** gateway 生成的 opaque 識別碼；單次可用。 */
    launchId: string;
    /** 到期時間（epoch 毫秒）。 */
    expiresAt: number;
};

/** 已綁定的 launch context；`patientId`／`patientListId`／`encounterId` 是 PHI，不得寫進應用日誌。 */
export type BoundLaunchContext = {
    /** 綁定用的那個 opaque launch id。 */
    launchId: string;
    subject: string;
    clientId: string;
    /** patient compartment launch 的病人參照。 */
    patientId?: string;
    /** patient list launch 的 FHIR List id；授權的是清單成員而非單一病人。 */
    patientListId?: string;
    encounterId?: string;
    /** 綁定發生時間（epoch 毫秒）；綁定後的生命週期由 gateway 自管。 */
    boundAt: number;
};
