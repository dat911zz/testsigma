/**
 * Internal email/password login.
 *
 * Account-enumeration-resistance rule: EVERY failure branch (email doesn't exist, wrong
 * password, user suspended, not a member of the requested team) throws the exact SAME
 * UnauthorizedError with the same message. The failure path still runs a dummy verify so
 * response timing doesn't give away "this email doesn't exist".
 *
 * A deliberate decision — the session IS an api_token with `kind='session'`: no session
 * table, no cookie/CSRF in M2. A secret with a 1-day TTL is tied to EXACTLY one team;
 * switching teams means logging in again. In exchange, it's the only credential allowed to
 * carry never-grantable permissions (a real human sitting at the keyboard — see
 * `effectiveScopes`). When a real UI lands in M4, this is the place to revisit (httpOnly
 * cookie + CSRF) and record in docs/ARCHITECTURE_AUDIT.md.
 *
 * `audit` is a PORT injected from the shell layer, not an import: identity and governance
 * are at the same DAG layer, so identity may not import governance (see ../audit-port.ts).
 */
import { eq, sql } from "drizzle-orm";
import { UnauthorizedError } from "@testkite/contract";
import { withAuthRole, withTenant, type TkDb } from "../../kernel/index.js";
import type { AuditPort } from "../audit-port.js";
import { memberships, users } from "../db/schema.js";
import { effectiveScopes } from "../rbac/authorize.js";
import { ROLE_PERMISSIONS, type MembershipRole, type Permission } from "../rbac/permissions.js";
import { hashPassword, needsRehash, verifyPassword } from "./password.js";
import { issueApiToken } from "./issue.js";

export const SESSION_TTL_DAYS = 1;

/**
 * One single message for every failure branch. (The client sees the generic error-handler
 * message anyway because UnauthorizedError isn't tenantVisible — but even internal logs
 * must not distinguish "email doesn't exist" from "wrong password".)
 */
export const LOGIN_FAILED_MESSAGE = "incorrect email or password";

/** Dummy hash so the "no such user" branch costs exactly as much time as the "user found" branch. */
const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** Dummy uuid for the membership query on the "no such user" branch — always 0 rows. */
const DUMMY_USER_ID = "00000000-0000-0000-0000-000000000000";

/**
 * A port to run work OUTSIDE the response path. It exists to resist account enumeration
 * via timing, not for performance — see the note on the wrong-password branch below.
 */
export type DeferPort = (task: () => Promise<void>) => void;

/**
 * Default: queues the task into the `check` phase of the event loop — it only runs AFTER
 * the 401 response has finished being serialized, so not a single millisecond of it lands
 * in response time. The error is swallowed on purpose: one broken audit write must not
 * become an unhandled rejection that kills the API process. If the shell layer wants
 * logging, it injects its own `defer` (once a logging port exists in M4).
 */
const deferAfterResponse: DeferPort = (task) => {
  setImmediate(() => {
    void task().catch(() => undefined);
  });
};

export type LoginResult = {
  readonly secret: string;
  readonly expiresAt: Date;
  readonly teamId: string;
  readonly userId: string;
  readonly role: MembershipRole;
  readonly scopes: readonly Permission[];
};

export type LoginDeps = {
  readonly db: TkDb;
  readonly audit: AuditPort;
  readonly now?: () => Date;
  readonly defer?: DeferPort;
};

export async function loginWithPassword(
  deps: LoginDeps,
  input: { readonly email: string; readonly password: string; readonly teamId?: string },
): Promise<LoginResult> {
  const clock = deps.now ?? ((): Date => new Date());
  const defer = deps.defer ?? deferAfterResponse;
  const fail = new UnauthorizedError(LOGIN_FAILED_MESSAGE);

  // Phase 1 runs as role testkite_auth: the tenant is NOT known yet — it's exactly what
  // we're looking for. That role can only SELECT from users/memberships/api_tokens.
  const found = await withAuthRole(deps.db, async (tx) => {
    const rows = await tx
      .select({ id: users.id, hash: users.passwordHash, status: users.status })
      .from(users)
      .where(sql`lower(${users.email}) = lower(${input.email})`)
      .limit(1);
    const u = rows[0];
    // password_hash NULL = account only logs in via OIDC ⇒ 401, not 500.
    const usable =
      u !== undefined && u.hash !== null && u.status === "active"
        ? { id: u.id, hash: u.hash }
        : null;
    // The membership query runs EVEN WHEN there's no usable user — with a dummy uuid (0
    // rows). Same reasoning as DUMMY_HASH: merely whether this query runs at all is already
    // a timing difference that gives away which emails are real.
    const mem = await tx
      .select({
        teamId: memberships.teamId,
        role: memberships.role,
        createdAt: memberships.createdAt,
      })
      .from(memberships)
      .where(eq(memberships.userId, usable?.id ?? DUMMY_USER_ID))
      .orderBy(memberships.createdAt);
    if (usable === null) return null;
    return { userId: usable.id, hash: usable.hash, memberships: mem };
  });

  if (found === null) {
    await verifyPassword(DUMMY_HASH, input.password); // burn an equivalent amount of time
    throw fail;
  }
  if (!(await verifyPassword(found.hash, input.password))) {
    // Audit is written OUTSIDE the response path. Writing it synchronously here would open
    // ONE extra Postgres transaction (BEGIN → SET LOCAL ROLE → set_config → INSERT →
    // COMMIT) that the "email doesn't exist / OIDC-only / suspended" branch doesn't pay
    // for — measured during review: ~5.1–5.9ms on top of a ~23–29ms baseline (20–25%),
    // enough to count which emails are real even though the responses look identical. It
    // would defeat the exact protection DUMMY_HASH provides.
    // The outbox doesn't save us here: `enqueueOutbox` is itself a transaction on the same
    // path — what has to go is the SYNCHRONOUS part, not which table gets written.
    const at = clock();
    const teamId = found.memberships[0]?.teamId;
    defer(() => auditFailure(deps, teamId, input.email, at));
    throw fail;
  }

  const picked =
    input.teamId === undefined
      ? found.memberships[0]
      : found.memberships.find((m) => m.teamId === input.teamId);
  // Not a member ⇒ 401, and we do NOT confirm whether that team even exists.
  if (picked === undefined) throw fail;

  const teamId = picked.teamId;
  const role: MembershipRole = picked.role;
  // A real human's session carries the role's full permission set (effectiveScopes filters it one last time).
  const scopes = effectiveScopes(role, ROLE_PERMISSIONS[role], "session");
  const at = clock();

  return withTenant(deps.db, { teamId }, async (tx) => {
    const minted = await issueApiToken(
      tx,
      { teamId },
      {
        name: "session",
        scopes,
        expiresInDays: SESSION_TTL_DAYS,
        kind: "session",
        userId: found.userId,
        createdBy: found.userId,
      },
      at,
    );
    // Silent rehash when the old hash's argon2 parameters are weaker than the current ones —
    // folded into the same UPDATE as last_login_at, same transaction as the session just issued.
    const rehash = needsRehash(found.hash)
      ? { passwordHash: await hashPassword(input.password), updatedAt: at }
      : {};
    await tx
      .update(users)
      .set({ lastLoginAt: at, ...rehash })
      .where(eq(users.id, found.userId));
    await deps.audit(tx, { teamId }, {
      actorKind: "user",
      actorId: found.userId,
      action: "auth.login",
      severity: "LOW",
      targetKind: "api_token",
      targetId: minted.id,
    });
    return {
      secret: minted.secret,
      expiresAt: minted.expiresAt,
      teamId,
      userId: found.userId,
      role,
      scopes,
    };
  });
}

/**
 * A failed login still has to leave a trace — but audit_events is a TENANT-SCOPED table:
 * with no known tenant, there's nowhere to write it. A nonexistent user therefore produces
 * no audit entry (and must not: that would itself be an account-enumeration channel via the
 * audit table).
 *
 * ONLY called through `defer` — this runs after the 401 has already left the process. A
 * deliberate tradeoff: the audit line for a FAILED login can be lost if the process dies
 * mid-flight; in exchange, response time no longer depends on whether the email is real.
 */
async function auditFailure(
  deps: LoginDeps,
  teamId: string | undefined,
  email: string,
  now: Date,
): Promise<void> {
  if (teamId === undefined) return;
  await withTenant(deps.db, { teamId }, async (tx) => {
    await deps.audit(tx, { teamId }, {
      actorKind: "user",
      actorId: null,
      action: "auth.login_failed",
      severity: "MEDIUM",
      meta: { email, at: now.toISOString() },
    });
  });
}
