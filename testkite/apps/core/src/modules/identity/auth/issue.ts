/**
 * Issue and revoke api tokens. The secret is returned EXACTLY ONCE — there is no way to
 * read it back: the DB only ever keeps sha256(secret) and the `prefix`.
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
  // Never-grantable is gated HERE, at issue time — not only at use time.
  // A session created by loginWithPassword has already been filtered through
  // effectiveScopes(kind="session"), so this branch only guards tokens a user requested.
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
  if (row === undefined) throw new Error("issueApiToken: INSERT returned no id");
  return { id: row.id, prefix: minted.prefix, secret: minted.secret, expiresAt };
}

/** Idempotent revoke: calling it again on an already-revoked token still succeeds (no throw). */
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
  // Update matched nothing: either already revoked (idempotent, OK), or it doesn't exist /
  // belongs to another team — both of the latter cases are a 404, NEVER a 403.
  const still = await tx
    .select({ id: apiTokens.id })
    .from(apiTokens)
    .where(and(eq(apiTokens.teamId, teamId), eq(apiTokens.id, tokenId)))
    .limit(1);
  if (still[0] === undefined) throw new NotFoundError("api token");
}
