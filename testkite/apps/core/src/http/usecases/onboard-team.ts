/**
 * Onboarding = MỘT transaction (blueprint §3). Tầng shell là chỗ duy nhất được ghép
 * bốn module: identity (team/project/admin/service token) + governance (quota + audit)
 * + planning (3 env stub) + orchestration (egress observe 14 ngày). Mỗi module tự ghi
 * bảng của mình qua facade; `tx` được chuyền xuống nên hoặc TẤT CẢ, hoặc KHÔNG GÌ.
 *
 * Idempotency: `idempotencyKey` được băm sha256 thành một uuid tất định — chính là
 * teamId. Gọi lại cùng key ⇒ cùng teamId ⇒ mọi ghi rơi vào ON CONFLICT DO NOTHING.
 * Không cần bảng idempotency riêng, và không có cửa sổ race nào: khoá duy nhất của
 * `teams` là trọng tài.
 *
 * Route này cũng được NỘP TỪ ĐÂY chứ không từ module identity: use case chạm bốn
 * module, mà identity import ba module kia là đi ngược/ngang DAG.
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
  /** true = lần này thật sự tạo mới; false = chạy lại idempotent (không trả secret). */
  readonly created: boolean;
  readonly serviceTokenSecret: string | null;
};

export type OnboardDeps = {
  readonly db: TkDb;
  readonly now?: () => Date;
};

const SERVICE_TOKEN_DAYS = 365;

/**
 * teamId TIỀN SINH, tất định theo (org, idempotencyKey) — xem chú thích đầu file.
 * Dạng ra là uuid hợp lệ (nibble phiên bản = 4, nibble variant = 8) vì cột `teams.id`
 * là uuid thật, không phải text.
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
    // Chỉ lần tạo THẬT mới là một sự kiện; chạy lại idempotent không phải hành động
    // mới nên không được đẻ thêm dòng audit nào.
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
 * Registration của `POST /v1/teams`. Descriptor vẫn nằm ở @testkite/contract nên
 * OpenAPI, router và bộ cách ly L3 đọc cùng một nguồn; chỉ handler ở tầng shell.
 */
export function onboardRouteRegistration(deps: OnboardDeps): RouteRegistration {
  const descriptor = identityRoutes.find((r) => r.operationId === "onboardTeam");
  if (descriptor === undefined) throw new Error("descriptor thiếu: onboardTeam");

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
    // `serviceTokenSecret` KHÔNG có mặt trong hợp đồng 201 và cũng không được trả:
    // service account nhận secret qua đường phát token, không qua phản hồi onboarding.
    return {
      teamId: r.teamId,
      projectId: r.projectId,
      environmentIds: [...r.environmentIds],
      serviceTokenPrefix: r.serviceTokenPrefix,
      created: r.created,
    };
  });
}
