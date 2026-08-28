/**
 * Spec regen entry point. Run: `pnpm -F @testkite/contract openapi:gen`
 * (via tsx — Node 22's native type-stripping doesn't map `./x.js` → `x.ts`).
 *
 * Overwrites unconditionally: `openapi.json` is an OUTPUT, not a hand-edited file.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeOpenApiDocument } from "./openapi.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(packageRoot, "openapi.json");
writeFileSync(target, serializeOpenApiDocument(), "utf8");
process.stdout.write(`openapi.json written: ${target}\n`);
