/**
 * Launch context 讀取的 claim 名稱；authorization layer 不再出現 claim 名稱字面值。
 *
 * 這裡是「邏輯欄位名 → claim 名稱」的唯一來源。`TOKEN_CLAIM_NAMES` 只能覆寫
 * `CLAIM_NAME_FIELDS` 內的欄位；未設定或空物件時一律套用 `DEFAULT_CLAIM_NAMES`，
 * 因此設定前後的行為完全一致。
 *
 * Single source of truth mapping logical field names to JWT claim names.
 */

/** 可由 `TOKEN_CLAIM_NAMES` 覆寫的邏輯欄位。 */
export const CLAIM_NAME_FIELDS = [
    "patient",
    "patientList",
    "scopesSpaceDelimited",
    "scopesArray",
    "authorizedParty",
    "tokenId",
    "subjectName",
    "name",
] as const;

export type ClaimNameField = (typeof CLAIM_NAME_FIELDS)[number];

/** 完整的 claim 名稱對應；launch context provider 與 scope resolver 只讀這個。 */
export type ClaimNames = Record<ClaimNameField, string>;

/** 現行 Keycloak 部署使用的 claim 名稱，也就是 `TOKEN_CLAIM_NAMES` 未設定時的行為。 */
export const DEFAULT_CLAIM_NAMES: ClaimNames = {
    patient: "patient",
    patientList: "patient_list",
    scopesSpaceDelimited: "scope",
    scopesArray: "scp",
    authorizedParty: "azp",
    tokenId: "jti",
    subjectName: "subject_name",
    name: "name",
};

/**
 * 結構性 claim 名稱：`iss` 是 issuer policy 的比對對象、`sub` 是 OIDC 必要 claim，
 * 兩者由 gateway 自身定義而非 IdP 慣例，因此不接受 `TOKEN_CLAIM_NAMES` 覆寫。
 */
export const STRUCTURAL_CLAIM_NAMES = ["iss", "sub"] as const;

/** launch context 讀取 subject / issuer 時使用的結構性 claim 名稱。 */
export const STRUCTURAL_SUBJECT_CLAIM = "sub";
export const STRUCTURAL_ISSUER_CLAIM = "iss";

export type ClaimNameSettings = {
    /** 實際生效的 claim 名稱（已套用預設值）。 */
    names: ClaimNames;
    /**
     * 運維明確覆寫的欄位。空物件代表未設定 `TOKEN_CLAIM_NAMES`，此時不做任何
     * claim 名稱存在性檢查，行為與設定前完全一致。
     */
    overrides: Partial<ClaimNames>;
};

/** 套用設定的覆寫；未設定的欄位維持今日的名稱。 */
export function resolveClaimNameSettings(overrides?: Partial<ClaimNames>): ClaimNameSettings {
    const effectiveOverrides: Partial<ClaimNames> =
        overrides === undefined ? {} : Object.fromEntries(Object.entries(overrides).filter(([, c]) => c !== undefined));
    return {
        names: { ...DEFAULT_CLAIM_NAMES, ...effectiveOverrides },
        overrides: effectiveOverrides,
    };
}

export function isClaimNameField(field: string): field is ClaimNameField {
    return (CLAIM_NAME_FIELDS as readonly string[]).includes(field);
}