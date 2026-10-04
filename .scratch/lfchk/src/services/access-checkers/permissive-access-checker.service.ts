import type { AccessChecker, AccessCheckerFactory } from "../../types/access-checker";
import { accessGranted } from "../../types/access-decision";
import type { FhirRequestDetails } from "../../types/fhir-request";

/** DEV 用：有效 JWT 即放行；對齊 Java PermissiveAccessChecker。 */
export class PermissiveAccessCheckerService implements AccessChecker {
    checkAccess(_request: FhirRequestDetails) {
        return accessGranted();
    }
}

export const permissiveAccessCheckerFactory: AccessCheckerFactory = {
    create: () => new PermissiveAccessCheckerService(),
};
