/**
 * VALID: the runner is allowed the shared contract/compiler packages, zod, and node builtins —
 * only the core app and DB drivers are off limits.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { RUN_VERDICTS } from "@testkite/contract";

export const allowed = { readFileSync, z, RUN_VERDICTS };
