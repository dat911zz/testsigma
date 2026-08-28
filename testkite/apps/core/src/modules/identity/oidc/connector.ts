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
 */
import * as client from "openid-client";
import { and, eq, isNull, sql } from "drizzle-orm";
import { NotFoundError, UnauthorizedError } from "@testkite/contract";
import { withAuthRole, withTenant, type TkDb } from "../../kernel/index.js";
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
};

type ConnectorRow = typeof idnOidcConnectors.$inferSelect;

export type OidcDeps = { readonly db: TkDb; readonly now?: () => Date };

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
          });
        return rows[0];
      });
      if (consumed === undefined) throw invalid;
      if (consumed.expiresAt.getTime() < now().getTime()) throw invalid;

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
      const mapping = row.roleMapping as Record<string, string>;
      const mapped = groups.map((g) => mapping[g]).find((r): r is string => r !== undefined);
      const role = (mapped ?? row.defaultRole) as MembershipRole;

      // Standard OIDC claim, paired with `email`. The IdP not sending it ⇒ treated as NOT verified.
      const emailVerified = claims["email_verified"] === true;

      const userId = await withTenant(deps.db, { teamId: row.teamId }, async (tx) => {
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
          await tx
            .insert(memberships)
            .values({ teamId: row.teamId, userId: known, role })
            .onConflictDoNothing({ target: [memberships.teamId, memberships.userId] });
          return known;
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
        return id;
      });

      return { teamId: row.teamId, userId, email, subject, role, groups };
    },
  };
}
