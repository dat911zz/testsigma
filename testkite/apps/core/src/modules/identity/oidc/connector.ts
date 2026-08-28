/**
 * Connector OIDC generic — authorization code + PKCE S256, id_token verify bằng JWKS.
 *
 * BA ĐIỀU BẮT BUỘC, mỗi điều có bằng chứng spike 2026-08-28 đứng sau:
 *  1. `enableNonRepudiationChecks(config)`: openid-client MẶC ĐỊNH KHÔNG kiểm chữ ký
 *     id_token (OIDC Core §3.1.3.7 mục 6 cho phép khi token về thẳng qua TLS). Đã tái
 *     hiện: token ký bằng khoá ngoài JWKS được CHẤP NHẬN nếu không bật cờ này. TestKite
 *     tự host Keycloak sau reverse proxy nội bộ ⇒ không được hưởng giả định TLS đó.
 *  2. `allowInsecureRequests` CHỈ khi connector bật cờ `allow_insecure_http` (mock/dev).
 *     Mặc định openid-client chặn http:// với "only requests to HTTPS are allowed".
 *  3. state DÙNG MỘT LẦN, có hạn 10 phút, lưu trong DB — không cookie, không bộ nhớ tiến trình.
 *
 * ĐIỀU THỨ TƯ, về ghép identity vào `users` — cùng hạng nghiêm trọng với ba điều trên:
 * `users` là bảng TOÀN CỤC còn connector thì MỖI TEAM tự cấu hình (Keycloak của chính
 * họ, admin của họ tự quản). Ghép bằng email ⇒ team B khai `email` của người chỉ thuộc
 * team A là mint được phiên mang userId thật của người đó. Nên:
 *   - Khoá tra cứu là `(connector_id, sub)` trong `idn_oidc_identities` — `sub` chỉ có
 *     nghĩa trong phạm vi connector, team khác không giả được.
 *   - Email CHỈ dùng ở lần đầu của một `sub`, và chỉ được phép trỏ vào một tài khoản ĐÃ
 *     CÓ khi thoả CẢ HAI: IdP khẳng định `email_verified`, VÀ team này đã tự bảo lãnh
 *     người đó bằng membership sẵn có (luồng "mời trước, SSO sau"). Không đủ ⇒ 401.
 *   - Email chưa ai dùng ⇒ tạo user mới, và `email_verified_at` chép ĐÚNG những gì IdP
 *     nói, không tự tuyên bố là đã xác minh.
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

/** Cache Configuration theo connector (discovery là một round-trip HTTP mỗi lần). */
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
  // Bắt buộc kiểm chữ ký id_token — xem điều (1) đầu file.
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
      const invalid = new UnauthorizedError("đăng nhập OIDC không hợp lệ");

      // Tiêu thụ state MỘT LẦN, ngay trong một UPDATE có điều kiện — hai callback
      // song song với cùng state thì chỉ một cái thắng (không cần khoá riêng).
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
        // Hết hạn / sai aud / sai iss / chữ ký lạ — tất cả ra CÙNG một 401.
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

      // Claim chuẩn OIDC, đi cặp với `email`. IdP không phát ⇒ coi như CHƯA xác minh.
      const emailVerified = claims["email_verified"] === true;

      const userId = await withTenant(deps.db, { teamId: row.teamId }, async (tx) => {
        // (1) Neo theo (connector, sub): đường đi của mọi lần đăng nhập sau lần đầu.
        //     Không đụng tới email — user đổi email ở IdP vẫn là đúng người đó.
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

        // (2) Lần đầu của `sub` này. Email đối chiếu theo lower() — đúng cột của
        //     unique index `users_email_lower_uidx`, không để "A@x" lách thành user khác.
        const existing = await tx
          .select({ id: users.id })
          .from(users)
          .where(sql`lower(${users.email}) = lower(${email})`)
          .limit(1);
        const found = existing[0];

        let id: string;
        if (found !== undefined) {
          // Tài khoản ĐÃ CÓ (có thể thuộc team khác): chỉ được liên kết khi IdP xác
          // minh email VÀ team này đã tự mời người đó. Thiếu một trong hai ⇒ CÙNG
          // một 401 với mọi nhánh hỏng khác, không nói vì sao (không làm oracle).
          if (!emailVerified) throw invalid;
          const member = await tx
            .select({ id: memberships.id })
            .from(memberships)
            .where(and(eq(memberships.teamId, row.teamId), eq(memberships.userId, found.id)))
            .limit(1);
          if (member[0] === undefined) throw invalid;
          id = found.id;
        } else {
          // Email chưa ai dùng ⇒ không có tài khoản nào để chiếm: tạo mới, ghi
          // email_verified_at ĐÚNG như IdP nói (null khi chưa xác minh).
          const created = await tx
            .insert(users)
            .values({
              email,
              displayName: email.split("@")[0] ?? email,
              emailVerifiedAt: emailVerified ? now() : null,
            })
            .returning({ id: users.id });
          const newId = created[0]?.id;
          if (newId === undefined) throw new Error("oidc: không tạo được user");
          id = newId;
          // Provisioning just-in-time: có tài khoản IdP + connector của team ⇒ có membership.
          await tx
            .insert(memberships)
            .values({ teamId: row.teamId, userId: id, role })
            .onConflictDoNothing({ target: [memberships.teamId, memberships.userId] });
        }

        // Neo lại để lần sau không còn phải hỏi tới email nữa. Hai tab đăng nhập
        // song song cùng `sub` ⇒ một cái thắng, cái kia bỏ qua (cùng userId).
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
