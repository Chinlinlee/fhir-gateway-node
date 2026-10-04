/**
 * Launch context store 的窄介面（ADR-0002 Module 1）。
 *
 * launch context 歸 gateway 所有：EHR 先建立一份尚未綁定到任何使用者的 context，
 * gateway 生成 opaque 的 launch id 交給 EHR；使用者完成認證的那一刻（authorization flow 的
 * callback）才把 launch id 綁到 `(subject, client id)`，之後每一次 FHIR 存取都依這組鍵回讀。
 *
 * 介面刻意維持窄：建立未綁定、依 launch id 查可用性、綁定到 `(subject, client id)`、
 * 依該鍵回讀、刪除。
 * 索引鍵選 `(subject, client id)` 是因為三家 IdP 都保證的只有 `sub` 加 `azp`／`client_id`
 * （ADR-0002:19）。
 *
 * `authorize` 在轉發給 IdP 之前必須先確認 launch id 真的存在且還沒被綁走，因此介面需要
 * 依 launch id 查一次；這與 `bind` 是兩件事：查詢不改變任何狀態。
 *
 * Narrow store seam: create an unbound context, look it up by launch id, bind it to
 * `(subject, client id)`, read it back by that key, delete it. Nothing else belongs here.
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

    /** 依 `(subject, client id)` 回讀綁定後的 launch context；查無回傳 `undefined`。 */
    get: (subject: string, clientId: string) => Promise<BoundLaunchContext | undefined>;

    /** 刪除 `(subject, client id)` 的綁定；原本沒有綁定時回傳 `false`。 */
    delete: (subject: string, clientId: string) => Promise<boolean>;
};

/** EHR 註冊一次 launch 時送進來的內容；病人必要、就診選填。 */
export type CreateLaunchContextInput = {
    patientId: string;
    encounterId?: string;
    /** 未綁定 launch context 的存活秒數；由呼叫端自設定來源決定。 */
    ttlSeconds: number;
};

/** 建立成功後交給 EHR 的 launch id 與它的有效期。 */
export type CreatedLaunchContext = {
    /** gateway 生成的 opaque 識別碼；單次可用。 */
    launchId: string;
    /** 到期時間（epoch 毫秒）。 */
    expiresAt: number;
};

/** 已綁定的 launch context；`patientId`／`encounterId` 是 PHI，不得寫進應用日誌。 */
export type BoundLaunchContext = {
    /** 綁定用的那個 opaque launch id。 */
    launchId: string;
    subject: string;
    clientId: string;
    patientId: string;
    encounterId?: string;
    /** 綁定發生時間（epoch 毫秒）；綁定後的生命週期由 gateway 自管。 */
    boundAt: number;
};
