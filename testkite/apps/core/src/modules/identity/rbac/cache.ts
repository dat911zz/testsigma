/**
 * Cache quyền TTL 60s (blueprint §3). Đây là cache CỦA MỘT TIẾN TRÌNH, không phải
 * Redis: hệ quả là mỗi instance API có thể lệch nhau tối đa 60s sau khi đổi vai.
 * Chấp nhận được vì (a) action HIGH bỏ qua cache hoàn toàn — xem Task 6, và
 * (b) đổi vai gọi invalidateTeam() ngay trong tiến trình xử lý — chỗ gọi thật là
 * `identity/routes.ts::setMemberRole`, ngay sau khi UPDATE commit.
 *
 * Key của cache là SHA-256 hex của secret (authenticator.ts), KHÔNG phải secret thô:
 * không có đường nào để bearer token nằm nguyên văn trong bộ nhớ tiến trình.
 *
 * KHÔNG dùng `now` mặc định là Date.now trong test: clock được tiêm để test TTL
 * không cần sleep.
 */
import type { CredentialKind } from "./authorize.js";
import type { MembershipRole, Permission } from "./permissions.js";

export const AUTHZ_CACHE_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 10_000;

/**
 * Nguyên một RequestContext đã tính xong, không chỉ mỗi vai: hook auth (Task 6)
 * phải dựng lại được context ĐẦY ĐỦ từ cache hit, nếu không "cache hit" vẫn phải
 * chạm DB để lấy userId/tokenId và TTL 60s trở thành đồ trang trí.
 */
export type CachedGrant = {
  readonly teamId: string;
  readonly userId: string | null;
  readonly tokenId: string;
  readonly authKind: CredentialKind;
  readonly role: MembershipRole;
  readonly scopes: readonly Permission[];
  readonly cachedAt: number;
};

export type AuthzCache = {
  get: (key: string) => CachedGrant | undefined;
  set: (key: string, grant: CachedGrant) => void;
  invalidateTeam: (teamId: string) => void;
  size: () => number;
};

export function createAuthzCache(opts: {
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly maxEntries?: number;
} = {}): AuthzCache {
  const ttl = opts.ttlMs ?? AUTHZ_CACHE_TTL_MS;
  const now = opts.now ?? Date.now;
  const max = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const store = new Map<string, CachedGrant>();

  return {
    get(key) {
      const hit = store.get(key);
      if (hit === undefined) return undefined;
      if (now() - hit.cachedAt > ttl) {
        store.delete(key);
        return undefined;
      }
      return hit;
    },
    set(key, grant) {
      // Map giữ thứ tự chèn ⇒ entry cũ nhất là key đầu tiên (FIFO, đủ cho một cache 60s).
      if (store.size >= max) {
        const oldest = store.keys().next();
        if (!oldest.done) store.delete(oldest.value);
      }
      store.set(key, { ...grant, cachedAt: now() });
    },
    invalidateTeam(teamId) {
      for (const [k, v] of store) if (v.teamId === teamId) store.delete(k);
    },
    size: () => store.size,
  };
}
