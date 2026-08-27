/** VI PHẠM CÓ CHỦ ĐÍCH: builtin dạng TRẦN — Node nạp y hệt bản có tiền tố `node:`. */
import { execSync } from "child_process";
import { hostname } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { setTimeout as delay } from "timers/promises";

export const shellOut = execSync;
export const host = hostname;
export const joinPath = join;
export const toPath = fileURLToPath;
export const sleep = delay;
