/** DELIBERATE VIOLATION — four kinds of purity break in one file. */
import { readFileSync } from "node:fs";

export const readIt = readFileSync;
export const stamp = Date.now();
export const jitter = Math.random();
export const fromEnv = process.env["TESTKITE_BASE_URL"];
