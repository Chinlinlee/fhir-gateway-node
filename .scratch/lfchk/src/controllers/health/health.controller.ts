export abstract class HealthController {
    static getHealth() {
        return { status: "ok" as const };
    }
}
