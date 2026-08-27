/**
 * Entry regen spec. Chạy: `pnpm -F @testkite/contract openapi:gen`
 * (qua tsx — type-stripping gốc của Node 22 không ánh xạ `./x.js` → `x.ts`).
 *
 * Ghi ĐÈ vô điều kiện: `openapi.json` là ĐẦU RA, không phải file người sửa tay.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeOpenApiDocument } from "./openapi.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(packageRoot, "openapi.json");
writeFileSync(target, serializeOpenApiDocument(), "utf8");
process.stdout.write(`openapi.json đã ghi: ${target}\n`);
