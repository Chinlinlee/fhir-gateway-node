import type { SmartFhirScope } from "../services/smart-scope.service";
import type { VerifiedJwt } from "./verified-jwt";

/**
 * Launch context 內的 agent 身分；對齊 AuditEvent 記錄的欄位。
 * Agent identity recorded by AuditEvents.
 */
export type LaunchAgent = {
    /** JWT `azp`；gateway 代理流程下它是 gateway 自己的 IdP client，不是 App。 */
    authorizedParty?: string;
    /** JWT `iss`；AuditEvent agent identifier 的 system。 */
    issuer?: string;
    /** JWT `jti`；token id，同時是回讀 launch context 的索引鍵。 */
    tokenId?: string;
    /** JWT `sub`；token 主體，與 `LaunchContext.subject` 同值。 */
    subject?: string;
    /** JWT `subject_name` 或 `name`；顯示名稱。 */
    displayName?: string;
};

/**
 * Launch context：授權裁決的輸入 DTO，IdP 中立。Authorization layer 只讀這個 DTO。
 *
 * **欄位來自兩個地方，這是刻意的**（ADR-0002）：
 * - `patientId`／`patientListId` 是 PHI，來自 **gateway 自己的 launch context store**，
 *   不在 access token 裡。store 查不到就是沒有病人限制以外的任何意義——需要它們的 checker
 *   會拒絕（401）。
 * - `subject`／`scopes`／`agent` 不是 PHI，來自 **verified token**：scope 是 AS 的授權決定，
 *   gateway 去猜等於越權。
 */
export type LaunchContext = {
    /** Token 主體（JWT `sub`）。 */
    subject: string | undefined;
    /** patient compartment launch 綁定的病人；來自 store，不在 token 裡。 */
    patientId: string | undefined;
    /** patient list launch 綁定的 FHIR List；來自 store，不在 token 裡。 */
    patientListId: string | undefined;
    /** 已解析的 SMART FHIR scopes。 */
    scopes: readonly SmartFhirScope[];
    /** AuditEvent 使用的 agent 身分欄位。 */
    agent: LaunchAgent;
};

/**
 * LaunchContextProvider：把 verified token 轉譯成 LaunchContext。
 * 唯一知道 claim 名稱的地方；換 IdP 只需換這個 provider。
 *
 * 非同步是因為病人參照要查 launch context store（ADR-0002），不是因為 token。
 */
export type LaunchContextProvider = {
    create: (token: VerifiedJwt) => Promise<LaunchContext>;
};
