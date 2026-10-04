import type { SmartFhirScope } from "../services/smart-scope.service";
import type { VerifiedJwt } from "./verified-jwt";

/**
 * Launch context 內的 agent 身分；對齊 AuditEvent 記錄的欄位。
 * Agent identity recorded by AuditEvents.
 */
export type LaunchAgent = {
    /** JWT `azp`；被授權的 client。 */
    authorizedParty?: string;
    /** JWT `iss`；AuditEvent agent identifier 的 system。 */
    issuer?: string;
    /** JWT `jti`；token id。 */
    tokenId?: string;
    /** JWT `sub`；token 主體，與 `LaunchContext.subject` 同值。 */
    subject?: string;
    /** JWT `subject_name` 或 `name`；顯示名稱。 */
    displayName?: string;
};

/**
 * Launch context：verified token 轉譯後的 IdP 中立 DTO。
 * Authorization layer 只讀這個 DTO，不再直接讀 raw JWT claims。
 * IdP-neutral DTO the authorization layer consumes instead of raw JWT claims.
 */
export type LaunchContext = {
    /** Token 主體（JWT `sub`）。 */
    subject: string | undefined;
    /** 授權的 patient id；來自 patient claim，未驗證合法性。 */
    patientId: string | undefined;
    /** patient-list id；來自 patient_list claim。 */
    patientListId: string | undefined;
    /** 已解析的 SMART FHIR scopes。 */
    scopes: readonly SmartFhirScope[];
    /** AuditEvent 使用的 agent 身分欄位。 */
    agent: LaunchAgent;
};

/**
 * LaunchContextProvider：把 verified token 轉譯成 LaunchContext。
 * 唯一知道 claim 名稱的地方；換 IdP 只需換這個 provider。
 */
export type LaunchContextProvider = {
    create: (token: VerifiedJwt) => LaunchContext;
};
