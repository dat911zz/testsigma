/**
 * Phát và thu hồi api token. Secret trả về ĐÚNG MỘT LẦN — không có đường đọc lại:
 * DB chỉ giữ sha256(secret) và `prefix`.
 */
import { and, eq, isNull } from "drizzle-orm";
import { NotFoundError } from "@testkite/contract";
import { assertTenantContext, type TenantContext, type TkTx } from "../../kernel/index.js";
import { apiTokens } from "../db/schema.js";
import { assertGrantable } from "../rbac/authorize.js";
import type { CredentialKind } from "../rbac/authorize.js";
import { expiryFromDays, mintTokenSecret } from "./token.js";

export type IssueTokenInput = {
  readonly name: string;
  readonly scopes: readonly string[];
  readonly expiresInDays: number;
  readonly kind: CredentialKind;
  readonly userId: string | null;
  readonly createdBy: string | null;
};

export type MintedApiToken = {
  readonly id: string;
  readonly prefix: string;
  readonly secret: string;
  readonly expiresAt: Date;
};

export async function issueApiToken(
  tx: TkTx,
  ctx: TenantContext,
  input: IssueTokenInput,
  now: Date,
): Promise<MintedApiToken> {
  const teamId = assertTenantContext(ctx);
  // Never-grantable chặn ở ĐÂY, lúc phát — không phải chỉ lúc dùng.
  // Session do loginWithPassword tạo đã lọc qua effectiveScopes(kind="session"),
  // nên nhánh này chỉ gác token do người dùng xin.
  if (input.kind !== "session") assertGrantable(input.scopes);
  const expiresAt = expiryFromDays(input.expiresInDays, now);
  const minted = mintTokenSecret();
  const rows = await tx
    .insert(apiTokens)
    .values({
      teamId,
      name: input.name,
      prefix: minted.prefix,
      tokenHash: minted.tokenHash,
      kind: input.kind,
      userId: input.userId,
      scopes: [...input.scopes],
      expiresAt,
      createdBy: input.createdBy,
    })
    .returning({ id: apiTokens.id });
  const row = rows[0];
  if (row === undefined) throw new Error("issueApiToken: INSERT không trả id");
  return { id: row.id, prefix: minted.prefix, secret: minted.secret, expiresAt };
}

/** Thu hồi idempotent: gọi lại trên token đã thu hồi vẫn thành công (không ném). */
export async function revokeApiToken(
  tx: TkTx,
  ctx: TenantContext,
  tokenId: string,
  now: Date,
): Promise<void> {
  const teamId = assertTenantContext(ctx);
  const rows = await tx
    .update(apiTokens)
    .set({ revokedAt: now })
    .where(and(eq(apiTokens.teamId, teamId), eq(apiTokens.id, tokenId), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id });
  if (rows[0] !== undefined) return;
  // Không cập nhật được: hoặc đã thu hồi rồi (idempotent, OK), hoặc không tồn tại /
  // thuộc team khác — cả hai trường hợp sau đều là 404, KHÔNG BAO GIỜ 403.
  const still = await tx
    .select({ id: apiTokens.id })
    .from(apiTokens)
    .where(and(eq(apiTokens.teamId, teamId), eq(apiTokens.id, tokenId)))
    .limit(1);
  if (still[0] === undefined) throw new NotFoundError("api token");
}
