/**
 * Onboarding = ONE transaction (blueprint §3). The shell layer is the only place allowed
 * to combine four modules: identity (team/project/admin/service token) + governance
 * (quota + audit) + planning (3 env stubs) + orchestration (14-day egress observe). Each
 * module writes its own tables through its facade; `tx` is passed all the way down so it's
 * either ALL of it, or NONE of it.
 *
 * Idempotency: `idempotencyKey` is sha256-hashed into a deterministic uuid — which becomes
 * the teamId. Calling again with the same key ⇒ same teamId ⇒ every write falls into ON
 * CONFLICT DO NOTHING. No separate idempotency table needed, and no race window: the
 * unique key on `teams` is the arbiter.
 *
 * This route is also REGISTERED FROM HERE rather than from the identity module: the use
 * case touches four modules, and identity importing the other three would go
 * backward/sideways across the DAG.
 */
import { createHash } from "node:crypto";
import { identityRoutes } from "@testkite/contract";
import { withTenant, type TkDb } from "../../modules/kernel/index.js";
import { provisionTeamCore } from "../../modules/identity/index.js";
import { seedQuotaDefaults, writeAuditEvent } from "../../modules/governance/index.js";
import { seedEnvironmentStubs } from "../../modules/planning/index.js";
import { seedEgressObserve } from "../../modules/orchestration/index.js";
import { route, type RouteRegistration } from "../types.js";

export type OnboardInput = {
  readonly orgId: string;
  readonly name: string;
  readonly slug: string;
  readonly adminEmail: string;
  readonly baseUrl: string;
  readonly idempotencyKey: string;
  readonly actorUserId: string | null;
};

export type OnboardResult = {
  readonly teamId: string;
  readonly projectId: string;
  readonly environmentIds: readonly string[];
  readonly serviceTokenPrefix: string;
  /** true = actually created this time; false = an idempotent replay (no secret returned). */
  readonly created: boolean;
  readonly serviceTokenSecret: string | null;
};

export type OnboardDeps = {
  readonly db: TkDb;
  readonly now?: () => Date;
};

const SERVICE_TOKEN_DAYS = 365;

/**
 * teamId is PRE-GENERATED, deterministic from (org, idempotencyKey) — see the file header.
 * The output has the shape of a valid uuid (version nibble = 4, variant nibble = 8) because
 * the `teams.id` column is a real uuid, not text.
 */
export function teamIdFor(orgId: string, idempotencyKey: string): string {
  const h = createHash("sha256").update(`${orgId}:${idempotencyKey}`).digest("hex");
  return [h.slice(0, 8), h.slice(8, 12), `4${h.slice(13, 16)}`, `8${h.slice(17, 20)}`, h.slice(20, 32)].join("-");
}

export async function onboardTeam(deps: OnboardDeps, input: OnboardInput): Promise<OnboardResult> {
  const now = (deps.now ?? ((): Date => new Date()))();
  const teamId = teamIdFor(input.orgId, input.idempotencyKey);

  return withTenant(deps.db, { teamId }, async (tx) => {
    const core = await provisionTeamCore(
      tx,
      { teamId },
      {
        orgId: input.orgId,
        name: input.name,
        slug: input.slug,
        adminEmail: input.adminEmail,
        serviceTokenDays: SERVICE_TOKEN_DAYS,
      },
      now,
    );
    await seedQuotaDefaults(tx, { teamId });
    const environmentIds = await seedEnvironmentStubs(tx, { teamId }, {
      projectId: core.projectId,
      baseUrl: input.baseUrl,
    });
    await seedEgressObserve(tx, { teamId }, { baseUrl: input.baseUrl, now });
    // Only a REAL creation is an event; an idempotent replay isn't a new action, so it
    // must not produce another audit line.
    if (core.created) {
      await writeAuditEvent(tx, { teamId }, {
        actorKind: "user",
        actorId: input.actorUserId,
        action: "team.onboard",
        severity: "HIGH",
        targetKind: "team",
        targetId: teamId,
        meta: { slug: input.slug, baseUrl: input.baseUrl },
      });
    }
    return {
      teamId,
      projectId: core.projectId,
      environmentIds,
      serviceTokenPrefix: core.serviceTokenPrefix,
      created: core.created,
      serviceTokenSecret: core.serviceToken?.secret ?? null,
    };
  });
}

/**
 * Registration for `POST /v1/teams`. The descriptor still lives in @testkite/contract so
 * OpenAPI, the router, and the L3 isolation checks all read from the same source; only the
 * handler lives in the shell layer.
 */
export function onboardRouteRegistration(deps: OnboardDeps): RouteRegistration {
  const descriptor = identityRoutes.find((r) => r.operationId === "onboardTeam");
  if (descriptor === undefined) throw new Error("missing descriptor: onboardTeam");

  return route(descriptor, async ({ ctx, body }) => {
    const r = await onboardTeam(deps, {
      orgId: body.orgId,
      name: body.name,
      slug: body.slug,
      adminEmail: body.adminEmail,
      baseUrl: body.baseUrl,
      idempotencyKey: body.idempotencyKey,
      actorUserId: ctx.userId,
    });
    // `serviceTokenSecret` is NOT part of the 201 contract and is never returned:
    // the service account gets its secret via the token-issue path, not the onboarding response.
    return {
      teamId: r.teamId,
      projectId: r.projectId,
      environmentIds: [...r.environmentIds],
      serviceTokenPrefix: r.serviceTokenPrefix,
      created: r.created,
    };
  });
}
