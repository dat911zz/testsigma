/**
 * Bất biến bảo mật của authenticator: secret THÔ không được tồn tại ở đâu ngoài
 * đúng biến tham số. DB lưu SHA-256 (token.ts) — cache trong bộ nhớ cũng phải key
 * bằng SHA-256, nếu không bearer token thật của người dùng nằm nguyên văn trong
 * heap suốt TTL 60s (heap dump, snapshot, APM đều đọc được).
 *
 * Test này chạy hoàn toàn trên đường CACHE HIT nên không cần DB: db được thay bằng
 * proxy ném lỗi ngay khi bị chạm.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TkDb } from "../../kernel/index.js";
import type { AuthzCache, CachedGrant } from "../rbac/cache.js";
import { createAuthenticator } from "./authenticator.js";
import { mintTokenSecret } from "./token.js";

/** Chạm vào db trong bài test này = sai: cache hit thì không được có round-trip nào. */
const dbNeverUsed = new Proxy(
  {},
  {
    get(_target, prop): never {
      throw new Error(`authenticate() chạm DB (.${String(prop)}) dù cache đang hit`);
    },
  },
) as unknown as TkDb;

const GRANT: CachedGrant = {
  teamId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  tokenId: "33333333-3333-4333-8333-333333333333",
  authKind: "user_pat",
  role: "author",
  scopes: ["case:read"],
  cachedAt: 0,
};

function recordingCache(): { cache: AuthzCache; gets: string[] } {
  const gets: string[] = [];
  const cache: AuthzCache = {
    get(key) {
      gets.push(key);
      return GRANT;
    },
    set() {
      /* không dùng trên đường cache hit */
    },
    invalidateTeam() {
      /* không dùng trên đường cache hit */
    },
    size: () => 1,
  };
  return { cache, gets };
}

describe("authenticator — key của cache quyền", () => {
  it("key là SHA-256 hex của secret, KHÔNG BAO GIỜ là secret thô", async () => {
    const minted = mintTokenSecret();
    const { cache, gets } = recordingCache();
    const authenticator = createAuthenticator({ db: dbNeverUsed, cache });

    const principal = await authenticator.authenticate(minted.secret, { fresh: false });

    expect(principal).toMatchObject({ teamId: GRANT.teamId, role: "author" });
    expect(gets).toEqual([createHash("sha256").update(minted.secret).digest("hex")]);
    expect(gets).not.toContain(minted.secret);
  });

  it("secret sai định dạng: không chạm cache lẫn DB", async () => {
    const { cache, gets } = recordingCache();
    const authenticator = createAuthenticator({ db: dbNeverUsed, cache });

    expect(await authenticator.authenticate("khong-phai-token", { fresh: false })).toBeNull();
    expect(gets).toEqual([]);
  });
});
