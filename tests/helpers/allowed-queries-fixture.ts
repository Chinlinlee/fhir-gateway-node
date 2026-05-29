import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "allowed-queries");

export function allowedQueriesFixturePath(fileName: string): string {
    return join(fixturesDir, fileName);
}
