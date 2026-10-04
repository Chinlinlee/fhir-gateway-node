import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// Load .env from project root regardless of cwd
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });
