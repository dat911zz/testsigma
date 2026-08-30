/**
 * DELIBERATE VIOLATION: the runner is a separate, zero-credential process — it must not import
 * the core app nor any DB driver (docs/SYSTEM_DESIGN.md §5).
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { buildApp } from "@testkite/core";

export const smuggled = { drizzle, Pool, buildApp };
