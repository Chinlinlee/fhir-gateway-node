import { AuthenticationError } from "../errors/authentication.error";
import type { LaunchContext } from "../types/launch-context";
import { checkFhirIdOrFail } from "./fhir.util";

/** Launch context 中以 FHIR id 形式攜帶的欄位。 */
export type LaunchIdField = "patientId" | "patientListId";

/**
 * 取 launch context 的 id 欄位；缺少時以 AuthenticationError（401）報錯並命名邏輯欄位。
 * Reads a launch-context id field, naming the missing logical field on failure.
 */
export function getLaunchIdOrFail(launch: LaunchContext, field: LaunchIdField): string {
    const value = launch[field];
    if (value === undefined) {
        throw new AuthenticationError(`Missing required launch context field: ${field}`);
    }
    return checkFhirIdOrFail(value);
}
