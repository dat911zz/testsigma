/**
 * Generic OIDC connector — authorization code + PKCE S256, id_token verified via JWKS.
 *
 * THREE MANDATORY REQUIREMENTS, each backed by evidence from the 2026-08-28 spike:
 *  1. `enableNonRepudiationChecks(config)`: openid-client does NOT verify the id_token
 *     signature BY DEFAULT (OIDC Core §3.1.3.7 item 6 permits this when the token arrives
 *     directly over TLS). Reproduced: a token signed with a key outside the JWKS is
 *     ACCEPTED unless this flag is set. TestKite self-hosts Keycloak behind an internal
 *     reverse proxy ⇒ it does not get to rely on that TLS assumption.
 *  2. `allowInsecureRequests` ONLY when the connector has `allow_insecure_http` enabled
 *     (mock/dev). By default openid-client blocks http:// with "only requests to HTTPS are allowed".
 *  3. state is SINGLE-USE, has a 10-minute TTL, stored in the DB — no cookie, no process memory.
 *
 * A FOURTH REQUIREMENT, about linking identity into `users` — just as critical as the
 * three above: `users` is a GLOBAL table, while each connector is configured PER TEAM
 * (their own Keycloak, managed by their own admins). Linking by email ⇒ team B could claim
 * the `email` of someone who only belongs to team A and mint a session carrying that
 * person's real userId. So:
 *   - The lookup key is `(connector_id, sub)` in `idn_oidc_identities` — `sub` only has
 *     meaning within a connector's scope, another team can't fake it.
 *   - Email is used ONLY on a `sub`'s first login, and may only be linked to an EXISTING
 *     account when BOTH hold: the IdP asserts `email_verified`, AND this team has already
 *     vouched for that person via an existing membership (the "invite first, SSO later"
 *     flow). Not enough ⇒ 401.
 *   - If the email belongs to no one ⇒ create a new user, and `email_verified_at` copies
 *     EXACTLY what the IdP says, never self-declared as verified.
 *
 * A FIFTH REQUIREMENT, about the role on an ALREADY-ANCHORED login: the membership role is
 * derived from the IdP's groups, so it has to keep following them. Writing it with ON
 * CONFLICT DO NOTHING pinned it to whatever the first login happened to assert — a group
 * REVOKED at the IdP never reached TestKite, which is the one direction a role sync must
 * never lag in. Every anchored login now re-asserts the mapped role, and a role that
 * actually moves writes a HIGH audit entry in the SAME transaction.
 */
import * as client from "openid-client";
import { and, eq, isNull, sql } from "drizzle-orm";
import { NotFoundError, UnauthorizedError, ValidationFailedError } from "@testkite/contract";
import { withAuthRole, withTenant, type TkDb } from "../../kernel/index.js";
import type { AuditPort } from "../audit-port.js";
import {
  idnOidcConnectors,
  idnOidcIdentities,
  idnOidcLoginStates,
  memberships,
  users,
} from "../db/schema.js";
import type { MembershipRole } from "../rbac/permissions.js";

export const OIDC_STATE_TTL_MS = 600_000;

export type OidcIdentity = {
  readonly teamId: string;
  readonly userId: string;
  readonly email: string;
  readonly subject: string;
  readonly role: MembershipRole;
  readonly groups: readonly string[];
  /**
   * True when this login actually MOVED the stored membership role (see requirement (5)).
   * The caller uses it to drop the team's permission cache: without that, a downgrade
   * would sit behind the 60s TTL on every non-HIGH action.
   */
  readonly roleChanged: boolean;
};

type ConnectorRow = typeof idnOidcConnectors.$inferSelect;

/**
 * `audit` is the same PORT identity's routes take (audit-port.ts): the role sync writes its
 * HIGH entry INSIDE the transaction that moves the role, so there is no window where the
 * role changed and nothing recorded it.
 */
export type OidcDeps = {
  readonly db: TkDb;
  readonly audit: AuditPort;
  readonly now?: () => Date;
};

/** Configuration cache per connector (discovery is one HTTP round-trip each time). */
const configCache = new Map<string, { config: client.Configuration; at: number }>();
const CONFIG_TTL_MS = 900_000;

async function loadConnector(deps: OidcDeps, connectorId: string): Promise<ConnectorRow> {
  const rows = await withAuthRole(deps.db, async (tx) =>
    tx
      .select()
      .from(idnOidcConnectors)
      .where(and(eq(idnOidcConnectors.id, connectorId), eq(idnOidcConnectors.enabled, true)))
      .limit(1),
  );
  const row = rows[0];
  if (row === undefined) throw new NotFoundError("oidc connector");
  return row;
}

async function configFor(row: ConnectorRow): Promise<client.Configuration> {
  const hit = configCache.get(row.id);
  if (hit !== undefined && Date.now() - hit.at < CONFIG_TTL_MS) return hit.config;
  const config = await client.discovery(
    new URL(row.issuerUrl),
    row.clientId,
    row.clientSecret,
    undefined,
    row.allowInsecureHttp ? { execute: [client.allowInsecureRequests] } : {},
  );
  // Mandatory id_token signature check — see requirement (1) at the top of the file.
  client.enableNonRepudiationChecks(config);
  configCache.set(row.id, { config, at: Date.now() });
  return config;
}

/**
 * The roles SSO may assign — EXACTLY the `oidc_default_role` enum of drizzle/0018_oidc.sql,
 * and deliberately a SUBSET of `MembershipRole`. `role_mapping` is jsonb an operator typed
 * into a connector row, and `/v1/auth/oidc/{id}/callback` is a PUBLIC route, so the value
 * read out of it is neither validated nor privileged input:
 *   - `org_admin` / `instance_operator` are real roles that SSO must never mint. Whoever
 *     administers the IdP would otherwise be handing out org-level roles inside TestKite by
 *     editing a group.
 *   - anything else (a typo, a number, an object) is not a role at all, and casting it
 *     through to the enum column turns one mistyped letter into a 22P02 — a 500 that any
 *     unauthenticated caller can trigger by logging in.
 * Both cases resolve the same way: the mapping does not apply, so `default_role` does.
 */
export const OIDC_ASSIGNABLE_ROLES: readonly MembershipRole[] = [
  "team_admin",
  "author",
  "runner",
  "viewer",
];

export function toAssignableRole(x: unknown): MembershipRole | null {
  return OIDC_ASSIGNABLE_ROLES.find((r) => r === x) ?? null;
}

/**
 * First of the IdP's groups that maps to a role SSO may assign, or null. A group whose
 * mapped value is NOT assignable is skipped rather than treated as a match: "mapped to
 * something unusable" and "not mapped" have to mean the same thing, or the fallback to
 * `default_role` would depend on which mistake the operator made.
 */
function mappedRole(roleMapping: unknown, groups: readonly string[]): MembershipRole | null {
  if (typeof roleMapping !== "object" || roleMapping === null || Array.isArray(roleMapping)) {
    return null;
  }
  const table = new Map<string, unknown>(Object.entries(roleMapping));
  for (const g of groups) {
    const role = toAssignableRole(table.get(g));
    if (role !== null) return role;
  }
  return null;
}

/**
 * `/start` is a PUBLIC route, so `input.redirectUri` is attacker-controlled: whoever knows a
 * connector id can ask the API to send the IdP a callback URL of their choosing, and the
 * authorization code for that tenant then lands wherever they pointed it.
 *
 * The match is the WHOLE STRING against ONE entry. A prefix rule — the shortcut this function
 * exists to refuse — readmits the same attack twice over: `https://allowed.test/cb` would
 * admit `https://allowed.test/cb.attacker.test` (a different host entirely, because the dot
 * continues the authority when the entry has no trailing slash) and `https://allowed.test/cb/..%2f…`
 * (a different path). An allowlist that is not exact is not an allowlist.
 *
 * An EMPTY list refuses everything: connectors created before the column exists default to
 * '{}' and must be filled in by an operator rather than silently keeping the old behaviour.
 */
function assertAllowedRedirect(row: ConnectorRow, redirectUri: string): void {
  if (!row.redirectUris.includes(redirectUri)) {
    throw new ValidationFailedError("redirectUri is not registered for this connector", [
      "redirectUri must match one of the connector's registered redirect URIs exactly",
    ]);
  }
}

export type OidcConnector = {
  readonly start: (input: {
    readonly connectorId: string;
    readonly redirectUri: string;
  }) => Promise<{ readonly authorizationUrl: string; readonly state: string }>;
  readonly callback: (input: {
    readonly connectorId: string;
    readonly callbackUrl: string;
  }) => Promise<OidcIdentity>;
};

export function createOidcConnector(deps: OidcDeps): OidcConnector {
  const now = deps.now ?? ((): Date => new Date());

  return {
    async start(input: {
      readonly connectorId: string;
      readonly redirectUri: string;
    }): Promise<{ readonly authorizationUrl: string; readonly state: string }> {
      const row = await loadConnector(deps, input.connectorId);
      // BEFORE discovery and before a login state row exists: a refused redirect_uri must
      // cost the IdP nothing and must leave nothing behind for a later callback to trade in.
      assertAllowedRedirect(row, input.redirectUri);
      const config = await configFor(row);
      const codeVerifier = client.randomPKCECodeVerifier();
      const challenge = await client.calculatePKCECodeChallenge(codeVerifier);
      const state = client.randomState();
      const nonce = client.randomNonce();

      await withTenant(deps.db, { teamId: row.teamId }, async (tx) => {
        await tx.insert(idnOidcLoginStates).values({
          teamId: row.teamId,
          connectorId: row.id,
          state,
          nonce,
          codeVerifier,
          redirectUri: input.redirectUri,
          expiresAt: new Date(now().getTime() + OIDC_STATE_TTL_MS),
        });
      });

      const url = client.buildAuthorizationUrl(config, {
        redirect_uri: input.redirectUri,
        scope: row.scopes.join(" "),
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        nonce,
      });
      return { authorizationUrl: url.toString(), state };
    },

    async callback(input: {
      readonly connectorId: string;
      readonly callbackUrl: string;
    }): Promise<OidcIdentity> {
      const row = await loadConnector(deps, input.connectorId);
      const state = new URL(input.callbackUrl).searchParams.get("state") ?? "";
      const invalid = new UnauthorizedError("invalid OIDC login");

      // Consume state EXACTLY ONCE, in a single conditional UPDATE — two parallel
      // callbacks with the same state means only one wins (no separate lock needed).
      const consumed = await withTenant(deps.db, { teamId: row.teamId }, async (tx) => {
        const rows = await tx
          .update(idnOidcLoginStates)
          .set({ consumedAt: now() })
          .where(
            and(
              eq(idnOidcLoginStates.state, state),
              eq(idnOidcLoginStates.connectorId, row.id),
              isNull(idnOidcLoginStates.consumedAt),
            ),
          )
          .returning({
            nonce: idnOidcLoginStates.nonce,
            codeVerifier: idnOidcLoginStates.codeVerifier,
            expiresAt: idnOidcLoginStates.expiresAt,
            redirectUri: idnOidcLoginStates.redirectUri,
          });
        return rows[0];
      });
      if (consumed === undefined) throw invalid;
      if (consumed.expiresAt.getTime() < now().getTime()) throw invalid;
      // The allowlist is re-read HERE, from the connector as it stands now — not trusted
      // from a state row that may be ten minutes old. Removing a redirect URI has to kill
      // the logins already in flight through it, otherwise revocation only takes effect
      // after the last outstanding state expires.
      if (!row.redirectUris.includes(consumed.redirectUri)) throw invalid;

      const config = await configFor(row);
      let claims: Record<string, unknown>;
      try {
        const tokens = await client.authorizationCodeGrant(config, new URL(input.callbackUrl), {
          pkceCodeVerifier: consumed.codeVerifier,
          expectedState: state,
          expectedNonce: consumed.nonce,
        });
        claims = { ...tokens.claims() };
      } catch {
        // Expired / wrong aud / wrong iss / unknown signature — all become the SAME 401.
        throw invalid;
      }

      const subject = String(claims["sub"] ?? "");
      const email = String(claims[row.claimEmail] ?? "").toLowerCase();
      if (subject.length === 0 || email.length === 0) throw invalid;
      const rawGroups = claims[row.claimGroups];
      const groups = Array.isArray(rawGroups) ? rawGroups.map(String) : [];
      const role: MembershipRole = mappedRole(row.roleMapping, groups) ?? row.defaultRole;

      // Standard OIDC claim, paired with `email`. The IdP not sending it ⇒ treated as NOT verified.
      const emailVerified = claims["email_verified"] === true;

      const provisioned = await withTenant(deps.db, { teamId: row.teamId }, async (tx) => {
        // (1) Anchored by (connector, sub): the path every login after the first one takes.
        //     Doesn't touch email — a user who changes their email at the IdP is still the same person.
        const anchored = await tx
          .select({ userId: idnOidcIdentities.userId })
          .from(idnOidcIdentities)
          .where(
            and(
              eq(idnOidcIdentities.connectorId, row.id),
              eq(idnOidcIdentities.subject, subject),
            ),
          )
          .limit(1);
        const known = anchored[0]?.userId;
        if (known !== undefined) {
          // Requirement (5): re-assert the mapped role, don't just make sure a membership
          // exists. Read the current role FIRST — ON CONFLICT ... RETURNING would hand
          // back the value it just wrote, which cannot tell a change from a no-op.
          const before = await tx
            .select({ role: memberships.role })
            .from(memberships)
            .where(and(eq(memberships.teamId, row.teamId), eq(memberships.userId, known)))
            .limit(1);
          const previousRole = before[0]?.role;
          await tx
            .insert(memberships)
            .values({ teamId: row.teamId, userId: known, role })
            .onConflictDoUpdate({
              target: [memberships.teamId, memberships.userId],
              set: { role },
            });
          // `previousRole === undefined` = the membership did not exist and was just
          // created (someone removed from the team, logging back in through SSO). That is
          // provisioning, not a change, and the login itself is already audited.
          const roleChanged = previousRole !== undefined && previousRole !== role;
          if (roleChanged) {
            await deps.audit(tx, { teamId: row.teamId }, {
              actorKind: "system",
              actorId: known,
              action: "member.role_change",
              severity: "HIGH",
              targetKind: "membership",
              targetId: known,
              // `source` separates this from an operator's own setMemberRole: the same
              // action name with a different origin, which is what an auditor needs to see.
              // The groups that caused it are deliberately NOT repeated here — the
              // `auth.oidc_login` entry from this same login already carries them, and
              // meta has a hard 8 KiB ceiling that an IdP with many groups can reach.
              meta: { from: previousRole, to: role, source: "oidc", connectorId: row.id, subject },
            });
          }
          return { userId: known, roleChanged };
        }

        // (2) This `sub`'s first login. Email is matched via lower() — the same column the
        //     `users_email_lower_uidx` unique index uses, so "A@x" can't sneak in as a different user.
        const existing = await tx
          .select({ id: users.id })
          .from(users)
          .where(sql`lower(${users.email}) = lower(${email})`)
          .limit(1);
        const found = existing[0];

        let id: string;
        if (found !== undefined) {
          // An EXISTING account (possibly in another team): may only be linked when the
          // IdP verifies the email AND this team has already invited that person. Missing
          // either one ⇒ the SAME 401 as every other failure branch, with no explanation
          // (never act as an oracle).
          //
          // Note the deliberate asymmetry with requirement (5): this branch does NOT touch
          // the existing membership's role. The team invited this person AT a role, and
          // that invitation stands for the login that links the account; the IdP takes
          // over from the next login onward, through the anchored branch above.
          if (!emailVerified) throw invalid;
          const member = await tx
            .select({ id: memberships.id })
            .from(memberships)
            .where(and(eq(memberships.teamId, row.teamId), eq(memberships.userId, found.id)))
            .limit(1);
          if (member[0] === undefined) throw invalid;
          id = found.id;
        } else {
          // No one is using this email ⇒ no account to take over: create a new one, and
          // record email_verified_at EXACTLY as the IdP states it (null when unverified).
          const created = await tx
            .insert(users)
            .values({
              email,
              displayName: email.split("@")[0] ?? email,
              emailVerifiedAt: emailVerified ? now() : null,
            })
            .returning({ id: users.id });
          const newId = created[0]?.id;
          if (newId === undefined) throw new Error("oidc: failed to create the user");
          id = newId;
          // Just-in-time provisioning: an IdP account + the team's connector ⇒ a membership.
          await tx
            .insert(memberships)
            .values({ teamId: row.teamId, userId: id, role })
            .onConflictDoNothing({ target: [memberships.teamId, memberships.userId] });
        }

        // Anchor it so next time we never need to consult email again. Two tabs logging in
        // in parallel with the same `sub` ⇒ one wins, the other is a no-op (same userId).
        await tx
          .insert(idnOidcIdentities)
          .values({ teamId: row.teamId, connectorId: row.id, subject, userId: id })
          .onConflictDoNothing({
            target: [idnOidcIdentities.connectorId, idnOidcIdentities.subject],
          });
        // First login for this `sub`: the role was just provisioned, not moved.
        return { userId: id, roleChanged: false };
      });

      return {
        teamId: row.teamId,
        userId: provisioned.userId,
        email,
        subject,
        role,
        groups,
        roleChanged: provisioned.roleChanged,
      };
    },
  };
}
