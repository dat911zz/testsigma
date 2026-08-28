/** VALID: tests are allowed to read files — the golden suite lives on readFileSync. */
import { readFileSync } from "node:fs";

export const readFixture = (p: string): string => readFileSync(p, "utf8");
