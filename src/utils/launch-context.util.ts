import { AuthenticationError } from "../errors/authentication.error";
import type { LaunchContext } from "../types/launch-context";
import { checkFhirIdOrFail } from "./fhir.util";

/** Launch context 中以 FHIR id 形式攜帶的病人／清單參照欄位。 */
export type PatientReferenceField = "patientId" | "patientListId";

/**
 * 取 launch context 的病人參照欄位；缺少時以 AuthenticationError（401）報錯並命名邏輯欄位。
 *
 * 命名刻意避開 "launch id"：CONTEXT.md 的 **launch id** 是 EHR 建立一份 launch context 時
 * 取得的單次 opaque handle，這裡回傳的卻是病人或病人清單的參照。兩者混用會讓讀者以為
 * 這是同樣東西，而它們在資安上的角色恰好相反——launch id 不該出現在授權裁決裡。
 *
 * Reads a patient-reference field from the launch context, naming the missing field on failure.
 */
export function getPatientReferenceOrFail(launch: LaunchContext, field: PatientReferenceField): string {
    const value = launch[field];
    if (value === undefined) {
        throw new AuthenticationError(`Missing required launch context field: ${field}`);
    }
    return checkFhirIdOrFail(value);
}
