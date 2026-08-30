/**
 * Module: kernel
 * Owned tables: krn_ (outbox, migrations), sec_ (secrets envelope-encrypted)
 *
 * Rules (docs/SYSTEM_DESIGN.md §4):
 *  - Calling FORWARD along the DAG = import the facade (this file). Calling BACKWARD/SIDEWAYS = domain event via transactional outbox.
 *  - No other module may touch this module's tables (enforced by ownership.json + eslint-boundaries).
 *  - A repository must be constructed with a TenantContext (fail-closed) — see isolation layer L1.
 */
export const MODULE = "kernel" as const;

// Kernel's public facade. Other modules must import only from this file —
// never reach into `./db/*.js` directly.
export { withTenant, withAuthRole, withDispatchRole } from "./db/tenant.js";
// DB role owned by kernel. Downstream DAG modules (identity, authoring, ...) attach RLS
// policies using `appRole` sourced from HERE — do not redefine a pgRole of the same name in your own module.
export {
  APP_ROLE,
  appRole,
  AUTH_ROLE,
  authRole,
  DISPATCH_ROLE,
  dispatchRole,
  RELAY_ROLE,
  relayRole,
} from "./db/schema.js";
export { MissingTenantContextError, TenantRepo, assertTenantContext } from "./db/repo.js";
export { createDb, type DbHandle } from "./db/client.js";
export type { TenantContext, TkDb, TkTx } from "./db/types.js";
export { loadEnv, parseEnv, envSchema, type KernelEnv } from "./env.js";
export { enqueueOutbox, type OutboxEvent } from "./outbox/writer.js";
export {
  runRelayOnce,
  type OutboxRecord,
  type Publisher,
  type RelayOptions,
  type RelayResult,
} from "./outbox/relay.js";
