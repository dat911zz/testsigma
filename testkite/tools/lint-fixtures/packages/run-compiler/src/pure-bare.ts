/** DELIBERATE VIOLATION: a BARE builtin — Node loads it identically to the `node:`-prefixed form. */
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
