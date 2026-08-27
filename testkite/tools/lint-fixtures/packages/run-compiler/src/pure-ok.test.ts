/** HỢP LỆ: test được đọc file — golden suite sống bằng readFileSync. */
import { readFileSync } from "node:fs";

export const readFixture = (p: string): string => readFileSync(p, "utf8");
