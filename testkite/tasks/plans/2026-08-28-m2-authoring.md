# M2 — Authoring (schema `aut_*`, revision zstd, review + four-eyes, optimistic concurrency) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dựng trọn miền authoring của TestKite — bảng `aut_cases` (mở rộng từ M1 T5) / `aut_steps` / `aut_step_loops` / `aut_rest_steps` / `aut_case_revisions` / `aut_case_reviews`, cộng ba cơ chế quản trị đi kèm (revision append-only nén zstd, review + four-eyes có advisory lock, optimistic concurrency ETag/If-Match với diff 3 chiều) — để vòng đời **tạo case → sửa steps → submit review → review → promote** chạy trọn qua HTTP, và để `buildCompileSnapshot()` sinh đúng `CompileSnapshot` mà `@testkite/run-compiler` đang chờ.

**Architecture:** Authoring là module *sở hữu* prefix `aut_` (ownership.json). Nó đọc `projects`/`teams` qua **facade identity** (cạnh xuôi DAG) và `withTenant`/`appRole`/`TenantRepo` qua **facade kernel**. Ba lớp cách ly M1 giữ nguyên và được sao chép y hệt cho mọi bảng mới: L1 `TenantRepo` fail-closed, L2 composite FK `(team_id, parent)`, L2.5 RLS policy `NULLIF(current_setting('app.team_id', true), '')::uuid`. Ba cơ chế mới xếp chồng lên đó: (1) **revision** = ảnh chụp bất biến của case ở dạng canonical JSON → SHA-256 → zstd native của Node, ghi vào bảng mà role app **chỉ có GRANT SELECT + INSERT** — append-only là quyền Postgres, không phải quy ước; (2) **review** = máy trạng thái `draft → in_review → ready` với ràng buộc unique-partial "mỗi case tối đa 1 review đang mở", `promote` bọc trong `pg_advisory_xact_lock` theo `(team, case)`; (3) **optimistic concurrency** = cột `version` + `ETag`/`If-Match` (thiếu ⇒ **428**, lệch ⇒ **409** kèm diff 3 chiều base/mine/theirs sinh bởi hàm thuần tự viết, khoá theo **id step ổn định** chứ không theo ordinal).

**Tech Stack:** Node **≥ 22.15.0** (zstd native trong `node:zlib`), TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), pnpm workspace, vitest 3, zod 3, `drizzle-orm@0.45.2`, `drizzle-kit@0.31.10`, `pg@^8.23.0`, `@electric-sql/pglite@0.5.8` (unit DB), PostgreSQL 17 (CI + prod), Fastify 5 (route — do plan identity dựng skeleton), `zod-openapi@4.2.4` (sinh OpenAPI).

**Spec:** `../../../docs/SYSTEM_DESIGN.md` §2 (domain authoring: `aut_cases` đủ 5 timestamp workflow, `aut_steps` 6 kind, `aut_step_loops` 1:1, `aut_rest_steps`, `aut_case_revisions` snapshot zstd append-only), §3 (four-eyes = người-sửa-cuối-không-tự-promote; cách ly 3 lớp; cross-tenant ⇒ 404 không bao giờ 403), §4 (case version + ETag/If-Match, 428 nếu thiếu, 409 kèm diff 3 chiều; advisory lock; Run Compiler phase 1 ghim revision — schedule/CI dùng bản `ready`, ad-hoc dùng `latest`). Backlog: `../M2-identity-authoring.md` (4 dòng: Authoring, Four-eyes, Optimistic concurrency, và phần exit criteria "tạo case → sửa → review → promote chạy trọn qua API"). Plan anh em đã xong: `2026-08-27-m1-kernel-db.md` (pattern migration + RLS + grants), `2026-08-27-m1-contract-openapi.md`.

## Global Constraints

- TypeScript strict, `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true` — không `any`, không `!` phi lý.
- **Node floor = 22.15.0** (mốc `node:zlib` có zstd native). `testkite/package.json` `engines.node` phải nâng từ `">=22"` lên `">=22.15.0"` (Task 1) — CI `setup-node@v4` với `node-version: '22'` đã lấy bản 22.x mới nhất nên không cần sửa workflow.
- **KHÔNG thêm dependency mới nào** cho nén và cho diff. zstd = `node:zlib` (Task 1); diff 3 chiều = hàm thuần tự viết (Task 6). Căn cứ đo đạc ở mục spike.
- **Database = PostgreSQL 17.** Mọi bảng tenant-scoped: `team_id` là cột ĐẦU TIÊN + index dẫn đầu `team_id` + `UNIQUE(team_id, id)` + **composite FK** `(team_id, parent_id)`.
- Vị từ RLS viết Y HỆT mọi nơi: `` sql`team_id = NULLIF(current_setting('app.team_id', true), '')::uuid` `` — `NULLIF` là bắt buộc (spike M1: `RESET` một custom GUC trả về `''`, `''::uuid` ném 22P02 thay vì fail-closed).
- drizzle-kit **không sinh** `GRANT`. Mỗi migration sinh máy phải đi kèm một migration **viết tay** `*_grants.sql` theo đúng pattern `0002_rls_hardening.sql` / `0004_aut_cases_grants.sql` / `0006_outbox_grants.sql`, cộng entry thủ công trong `apps/core/drizzle/meta/_journal.json` (`idx` +1, `tag` = tên file không đuôi, `when` = `node -e "console.log(Date.now())"`, `breakpoints: true`). Dấu `--> statement-breakpoint` giữa các statement là bắt buộc.
- Bảng thuộc **đúng 1 module** theo `testkite/ownership.json` — `aut_*` là của authoring. Muốn dữ liệu module khác: gọi facade (xuôi DAG) hoặc nghe domain event.
- Gọi ngược/ngang DAG = **transactional outbox** (`enqueueOutbox` từ facade kernel). Cấm `import ... from "bullmq"` ngoài kernel/relay/dispatcher.
- **Cross-tenant luôn 404, không bao giờ 403** (§3 L3). `403` CHỈ được dùng cho vi phạm chính sách **trong cùng tenant** (four-eyes) — khác hẳn việc dò id của tenant khác. Bộ test L3 sinh từ OpenAPI chỉ dò id chéo tenant nên không đụng tới 403 four-eyes.
- `apps/core` KHÔNG BAO GIỜ chứa binary browser (CI grep gate đã có).
- Commit nhỏ sau mỗi task; TDD đúng nghi thức (test ĐỎ trước, code sau); `verification-before-completion` trước khi tick.

## Phụ thuộc chéo — plan identity chạy song song

Plan identity (agent khác, cùng nhánh) **sở hữu bootstrap Fastify + auth middleware**. Plan này KHÔNG dựng lại chúng. Ràng buộc thực thi:

| Nhóm task | Phụ thuộc identity | Thực thi được ngay? |
|---|---|---|
| Task 1–13 (codec, schema, migration, DTO, diff, service, review, promote, race, snapshot) | Không | **CÓ** — chạy trước, không chờ ai |
| Task 14 (route HTTP) | **CÓ** — cần Fastify skeleton + middleware auth của identity | **KHÔNG** — chờ identity xong |
| Task 15 (tick backlog) | Sau Task 14 | Không |

**Interface giả định của identity** (Task 12 code theo đúng hình dạng này; nếu identity đặt tên khác thì CHỈ sửa hàm adapter `getAuth()` trong `routes/context.ts`, không sửa service):

```ts
/** Do middleware identity gắn vào mỗi request đã xác thực. */
export interface RequestAuth {
  readonly teamId: string;   // uuid — tenant đang phục vụ
  readonly userId: string;   // uuid — người thật hoặc service account
  readonly scopes: readonly string[]; // token.scopes ∩ rolePerms, đã tính sẵn
}
// Fastify augmentation do identity khai:
//   declare module "fastify" { interface FastifyRequest { auth: RequestAuth } }
```

**Đăng ký route theo pattern plugin**: mỗi module export một `FastifyPluginAsync` từ facade của mình; composition-root gọi `await app.register(authoringRoutes, { prefix: "/v1" })` theo thứ tự DAG.

### Đối chiếu 28-08 — plan identity ĐÃ nộp (996ecf0 + 0d844d7), Task 14 chịu 4 nghĩa vụ sau

Plan identity chấp nhận kiểu đăng ký plugin, đổi lại (xem mục "Đối chiếu" đầu plan identity):

1. **Ruột `getAuth()` đọc `req.tk`** (identity Task 6 decorate `request.tk`), KHÔNG phải `request.auth` như giả định gốc — đúng kịch bản "chỉ sửa một hàm adapter" đã lường.
2. **`InsufficientScopeError` phải kế thừa `ForbiddenError` của `@testkite/contract`** — nếu không, error handler chung của identity map nó thành 500.
3. **Mỗi route `/v1` của authoring phải có descriptor trong `ROUTES`** (`packages/contract/src/routes/index.ts`): khai descriptor trong file riêng rồi nối `...authoringRoutes` vào `ROUTES`, và đặt `config: { tk: descriptor }` khi đăng ký route — OpenAPI và bộ L3 đọc từ đó; identity Task 11 có gate biến việc quên descriptor thành CI đỏ.
4. **Thêm fixture id + body mẫu vào `test/isolation/fixtures.ts`** cho bộ L3 cross-tenant (authoring không tự viết bộ test cách ly riêng).

Đăng ký plugin qua tham số `plugins: readonly FastifyPluginAsync[]` của `buildHttpApp` (identity Task 6) — được register SAU hook auth.

**Xung đột file phải lường trước** (hai agent, một nhánh):

1. `apps/core/src/modules/identity/db/schema.ts` — Task 2 thêm **một cột** `allow_self_promote` vào `teams`. Thêm vào CUỐI danh sách cột của `teams`, không đụng dòng nào khác.
2. `apps/core/src/modules/identity/index.ts` — Task 2 thêm `teams` vào dòng `export { projects } from "./db/schema.js";`.
3. `apps/core/drizzle/` — **số thứ tự migration là tài nguyên tranh chấp**. Tên file dưới đây (`0007_…` → `0014_…`) là *dự kiến* khi không có ai chen ngang. Sau mỗi `git pull --rebase`, nếu identity đã chiếm số: **xoá file sinh máy vừa tạo, chạy lại `pnpm db:generate --name=<tag>`** (drizzle-kit tự lấy số trống kế tiếp và tự vá `_journal.json`), rồi **đổi tên file grants viết tay + sửa entry journal tương ứng**. Luôn tham chiếu migration bằng **tag**, không bằng số.
4. `packages/contract/openapi.json` — sinh lại (`pnpm openapi:gen`) sau mỗi lần rebase; gate drift so byte.

---

## Kết quả spike (ĐÃ CHẠY THẬT — 2026-08-28, sandbox này)

### 1. zstd native — CÓ, không thêm dependency

```
$ node -v
v22.22.2
$ node -e "const z=require('node:zlib'); console.log('zstdCompressSync' in z, typeof z.zstdCompressSync)"
true function
$ node -e "console.log(Object.keys(require('node:zlib')).filter(k=>/zstd/i.test(k)).join(','))"
ZstdCompress,ZstdDecompress,zstdCompress,zstdCompressSync,zstdDecompress,zstdDecompressSync,createZstdCompress,createZstdDecompress
```

Typings có đủ trong `@types/node@22.20.1` (bản workspace đang resolve từ `^22.10.0`):

```
zlib.d.ts:493  function zstdCompressSync(buf: InputType, options?: ZstdOptions): NonSharedBuffer;
zlib.d.ts:508  function zstdDecompressSync(buf: InputType, options?: ZstdOptions): NonSharedBuffer;
zlib.d.ts:590  const ZSTD_c_compressionLevel: number;
zlib.d.ts:160  interface ZstdOptions { flush?, finishFlush?, chunkSize?, params?, maxOutputLength? }
```

**Đo nén trên payload case JSON thật** (case checkout, step trộn action/if/for/rest, câu NLP dài, `$secret:` ref, biến `@{}`), trung bình 50 lần:

| Số step | raw | zstd-3 | zstd-10 | zstd-19 | gzip-9 | brotli |
|---:|---:|---|---|---|---|---|
| 12 | 3.709 B | 935 B (25,2%) 0,20ms | **877 B (23,6%) 0,21ms** | 871 B (23,5%) 2,07ms | 868 B (23,4%) 0,09ms | 677 B (18,3%) 8,64ms |
| 40 | 11.600 B | 1.267 B (10,9%) 0,27ms | **1.163 B (10,0%) 0,31ms** | 1.137 B (9,8%) 7,91ms | 1.258 B (10,8%) 0,14ms | 902 B (7,8%) 25,96ms |
| 120 | 34.019 B | 2.278 B (6,7%) 0,53ms | **1.868 B (5,5%) 0,83ms** | 1.824 B (5,4%) 28,50ms | 2.264 B (6,7%) 0,52ms | 1.443 B (4,2%) 80,58ms |

```
deterministic: true   roundtrip: true   magic: 28b52ffd
tiny raw 69  ->  zstd-10 78     ← payload bé PHÌNH RA
```

**Chốt:**
- **Dùng zstd native, level 10.** Level 19 chỉ hơn 0,1–0,2 điểm % nhưng chậm **9–34×**; level 3 (mặc định) thua rõ ở payload lớn. Brotli nhỏ hơn nhưng chậm 27–97× — sai chỗ: đây là đường ghi đồng bộ trong transaction.
- Nén **deterministic** (hai lần nén cùng input ra cùng byte) ⇒ dedup theo SHA-256 của **JSON canonical trước khi nén** là an toàn, và test golden so byte được.
- **Payload nhỏ phình ra** (69 B → 78 B). Bắt buộc có nhánh `codec = 'raw'` khi `compressed.length >= raw.length` — không phải tối ưu vặt, là tính đúng đắn của cột `payload_size`.

### 2. Diff 3 chiều — khảo sát thư viện, kết luận TỰ VIẾT

`pnpm info` (2026-08-28):

| Package | Version | License | Sửa lần cuối | Unpacked | Ghi chú |
|---|---|---|---|---|---|
| `json-diff3` | 1.1.1 | Zlib | **2022-05-06** | 59 KB | 3-way **merge**, ghim `node-diff3@1.0.0` (bản 2020) |
| `node-diff3` | 3.2.1 | MIT | 2026-06-03 | 152 KB | diff3 cho **mảng/văn bản**, không hiểu JSON |
| `jsondiffpatch` | 0.7.6 | MIT | 2026-05-14 | 163 KB | **2 chiều**, kéo theo `@dmsnell/diff-match-patch` |
| `rfc6902` | 5.3.0 | MIT | 2026-07-23 | 98 KB | **2 chiều**, JSON Patch |
| `fast-json-patch` | 3.1.1 | MIT | 2022-06-17 | 159 KB | **2 chiều** |
| `deep-object-diff` | 1.1.9 | MIT | 2022-11-12 | 23 KB | **2 chiều** |

**Không thư viện nào cho ra diff 3 chiều dạng báo cáo.** `json-diff3` là thư viện *merge* duy nhất và nó **vỡ ngay trên hình dạng của ta**:

```
$ node -e "const m=require('json-diff3'); m.diff3(mine, base, theirs)"
Error: Duplicate array key '[object Object]' at /steps
keys: [ 'diff3', 'jsonEqual' ]   (không có mergeJSON; không có objectHash cấu hình được)
```

Nó băm phần tử mảng bằng `String(obj)` nên mọi mảng object đều đụng khoá.

**Thử nghiệm nhiễu — chèn ĐÚNG 1 step vào giữa 4 step** (base 4 step, mine chèn step mới ở vị trí 2 và đánh lại ordinal):

```
jsondiffpatch (objectHash theo ordinal) : 4 mục — 3 mục "sửa renderedSentence" là GIẢ
jsondiffpatch (mặc định)                : 4 mục — y hệt
rfc6902 createPatch                     : 4 op  — 3 op "replace" là GIẢ
deep-object-diff detailedDiff           : 4 mục — 3 mục "updated" là GIẢ
jsondiffpatch (objectHash theo id ỔN ĐỊNH): 1 add + 3 mục `ordinal` đổi (nhiễu đánh số lại)
```

Nguyên nhân gốc: **ordinal là số**, chèn một step làm đánh số lại đuôi mảng ⇒ mọi thuật toán diff đều báo N thay đổi cho 1 hành động.

**Cách chuẩn hoá triệt tiêu nhiễu (đã đo):** bỏ `ordinal` khỏi payload diff, thay bằng **`after` = id của step liền trước** (null nếu đứng đầu), và khoá entry theo **id step ổn định**. Cùng ca chèn ở trên:

```
base -> mine  : 2 mục  [{"path":"/steps/s2/after","kind":"modified"},{"path":"/steps/s9","kind":"added"}]
base -> theirs: 2 mục  [{"path":"/name","kind":"modified"},{"path":"/steps/s4/renderedSentence","kind":"modified"}]
conflict paths: []                                  ← hai bên sửa chỗ khác nhau
```

Ca xung đột thật (cả hai cùng sửa câu của `s4`):

```
conflict thật: ["/steps/s4/renderedSentence"]
```

**Chốt: tự viết** `flattenRevision()` + `threeWayDiff()` (~120 dòng thuần, không I/O). Bốn lý do, theo thứ tự sức nặng:

1. Không có thư viện nào làm đúng việc (3 chiều dạng **báo cáo** cho body 409); cái duy nhất tự nhận 3 chiều thì lỗi cứng trên mảng object.
2. Dù lấy thư viện 2 chiều, ta vẫn phải tự chuẩn hoá `ordinal → after` — tức phần khó nhất vẫn là của ta, thư viện chỉ còn làm vòng `for` so sánh.
3. Body 409 phải là **DTO có zod schema** trong `packages/contract` (zod là nguồn, OpenAPI sinh ra, CI chặn drift). Định dạng delta ma thuật của `jsondiffpatch` (`_t:"a"`, khoá số dạng chuỗi, `_0` cho xoá) không diễn đạt được thành schema OpenAPI tử tế.
4. Global Constraint: không thêm dependency.

### 3. Postgres — advisory lock, append-only, bytea, partial unique (PGlite 18.3)

```
version: PostgreSQL 18.3 (PGlite 0.5.8) on wasm32-unknown-emscripten
advisory 2-int   : pg_advisory_xact_lock(hashtext($1), hashtext($2))       -> OK
advisory bigint  : pg_advisory_xact_lock(hashtextextended($1::text, 0))     -> OK
pg_locks trong tx: [{"locktype":"advisory","mode":"ExclusiveLock"}, ...]
sau COMMIT       : advisory lock còn 0  ← xact lock tự nhả, không cần UNLOCK
as tk_app (NOLOGIN NOSUPERUSER NOBYPASSRLS): pg_advisory_xact_lock -> OK  ← role app gọi được
partial unique index (WHERE state='open')  : OK
CHECK với biểu thức XOR                     : OK
bytea roundtrip                             : true, kiểu trả về = Uint8Array (KHÔNG phải Buffer)
GRANT SELECT,INSERT rồi UPDATE dưới role app: permission denied for table rev  ← APPEND-ONLY THẬT
hashtextextended('t1:c1',0) = 4507270282684556902
hashtextextended('t1:c2',0) = 8661962171965904302   ← khoá khác nhau, lock khác nhau
```

**Chốt:**
- Khoá advisory dùng **một bigint**: `pg_advisory_xact_lock(hashtextextended(<team_id> || ':' || <case_id>, 0))`. Dạng 2 × int4 chỉ có 32 bit mỗi vế nên đụng độ nhiều hơn. Đụng độ hash vẫn có thể xảy ra trên bigint — hậu quả duy nhất là **hai promote không liên quan xếp hàng nhau**, đúng bản chất "advisory". `hashtext*` không cam kết ổn định giữa các major PG, nhưng lock chỉ sống trong một transaction của một cluster đang chạy nên điều đó không ảnh hưởng.
- `pg_advisory_xact_lock` **tự nhả khi COMMIT/ROLLBACK** ⇒ không có đường rò lock; không bao giờ dùng `pg_advisory_lock` (session-scope) trong request path.
- **Append-only cưỡng chế bằng GRANT**, đã kiểm chứng: `GRANT SELECT, INSERT` (không UPDATE/DELETE) ⇒ `permission denied for table`.
- **bytea trả về `Uint8Array` trên PGlite, `Buffer` trên node-postgres** ⇒ mọi chỗ đọc blob phải `Buffer.from(value)`, không được `instanceof Buffer`.
- **PGlite một connection** (spike M1) ⇒ test tranh chấp advisory lock là *giả* trên PGlite; phải chạy trên Postgres thật qua `test/harness/realpg.ts` (Task 10).

### 4. drizzle-orm 0.45.2 — cái có, cái KHÔNG

```
$ node -e "const c=require('drizzle-orm/pg-core'); console.log('bytea?', Object.keys(c).includes('bytea'))"
bytea? false          ← KHÔNG có kiểu bytea
customType? true      ← phải tự khai bằng customType
unique('x').on() methods : constructor,nullsNotDistinct,build     ← có nullsNotDistinct()
text('a').array()        : function                                ← có mảng
uniqueIndex('ix').on(col) prototype: ...,concurrently,with,where,build   ← có .where() (partial index)
```

Hệ quả: Task 4 phải tự khai `bytea` bằng `customType`; Task 3 dùng `unique(...).nullsNotDistinct()` cho `(team_id, case_id, parent_step_id, ordinal)`; Task 10 dùng `uniqueIndex(...).where(...)` cho "tối đa 1 review mở". Nếu `pnpm db:generate` **không** sinh mệnh đề `WHERE` vào SQL, chuyển câu `CREATE UNIQUE INDEX ... WHERE` sang migration grants viết tay của chính task đó (đã có sẵn chỗ).

### 5. zod-openapi 4.2.4 với `z.unknown()`

```
$ node -e "createDocument({... C: z.object({path:z.string(), base:z.unknown().optional()})})"
"base": {}      ← schema rỗng = "any", hợp lệ trong OpenAPI 3.1
```

⇒ DTO diff được phép mang `base`/`value` kiểu `z.unknown()` mà không phá gate drift.

---

## File Structure

Tạo mới:

| File | Trách nhiệm |
|---|---|
| `apps/core/src/modules/authoring/revision/canonical.ts` | `canonicalJson()` — JSON khoá đã sắp, cơ sở cho SHA-256 ổn định |
| `apps/core/src/modules/authoring/revision/codec.ts` | `encodeRevision()` / `decodeRevision()` — zstd native + nhánh `raw` + sha256 |
| `apps/core/src/modules/authoring/revision/payload.ts` | `RevisionPayload` + `buildRevisionPayload()` — hình dạng ảnh chụp lưu trong blob |
| `apps/core/src/modules/authoring/revision/diff.ts` | `flattenRevision()` + `threeWayDiff()` — thuần, không I/O |
| `apps/core/src/modules/authoring/db/schema.ts` | **SỬA** — mở rộng `aut_cases`, thêm `aut_steps`/`aut_step_loops`/`aut_rest_steps`/`aut_case_revisions`/`aut_case_reviews` |
| `apps/core/src/modules/authoring/db/case-repo.ts` | `CaseRepo extends TenantRepo` — đọc/ghi case + steps (L1) |
| `apps/core/src/modules/authoring/db/revision-repo.ts` | `RevisionRepo extends TenantRepo` — chỉ `insert` + `findById` (append-only) |
| `apps/core/src/modules/authoring/db/review-repo.ts` | `ReviewRepo extends TenantRepo` |
| `apps/core/src/modules/authoring/errors.ts` | `IfMatchRequiredError` (428), `VersionConflictError` (409 + diff), `CaseStateError` (409), `FourEyesViolationError` (403), `CaseNotFoundError` (404) |
| `apps/core/src/modules/authoring/concurrency.ts` | `parseIfMatch()`, `formatETag()` — thuần |
| `apps/core/src/modules/authoring/case-service.ts` | `createCase()`, `replaceSteps()` — bump version + ghi revision |
| `apps/core/src/modules/authoring/review-service.ts` | `submitForReview()`, `decideReview()`, `promoteCase()` (advisory lock + four-eyes) |
| `apps/core/src/modules/authoring/snapshot.ts` | `buildCompileSnapshot()` — nối authoring → run-compiler |
| `apps/core/src/modules/authoring/routes/context.ts` | `getAuth()` — adapter DUY NHẤT chạm interface identity |
| `apps/core/src/modules/authoring/routes/cases.ts` | `authoringRoutes: FastifyPluginAsync` — 6 endpoint vòng đời |
| `packages/contract/src/schemas/authoring.ts` | zod DTO: `CaseStatus`, `CaseSummary`, `CaseChange`, `ThreeWayDiff`, `ReviewDecision` |
| `apps/core/drizzle/*_authoring_workflow.sql` + `*_authoring_workflow_grants.sql` | `aut_cases` mở rộng + `teams.allow_self_promote` |
| `apps/core/drizzle/*_aut_steps.sql` + `*_aut_steps_grants.sql` | 3 bảng step |
| `apps/core/drizzle/*_aut_case_revisions.sql` + `*_aut_case_revisions_grants.sql` | revision — GRANT **SELECT, INSERT** |
| `apps/core/drizzle/*_aut_case_reviews.sql` + `*_aut_case_reviews_grants.sql` | review + partial unique |
| `apps/core/test/authoring/*.test.ts` | test theo task (PGlite) |
| `apps/core/test/concurrency/promote-lock.test.ts` | tranh chấp advisory lock (Postgres thật) |

Sửa: `apps/core/src/modules/authoring/index.ts` (facade), `apps/core/src/modules/identity/db/schema.ts` (+1 cột `teams`), `apps/core/src/modules/identity/index.ts` (+export `teams`), `packages/contract/src/schemas/index.ts`, `packages/contract/src/openapi.ts`, `packages/contract/openapi.json`, `apps/core/src/composition-root.ts` (Task 12), `testkite/package.json` (`engines`), `testkite/tasks/M2-identity-authoring.md` (Task 13).

---

## Task 1 — Codec revision: canonical JSON + SHA-256 + zstd native

**Files:**
- Create: `apps/core/src/modules/authoring/revision/canonical.ts`
- Create: `apps/core/src/modules/authoring/revision/codec.ts`
- Create: `apps/core/src/modules/authoring/revision/codec.test.ts`
- Modify: `testkite/package.json` (`engines.node`)

**Interfaces:**
- Consumes: không có (thuần, chỉ `node:zlib` + `node:crypto`).
- Produces:
  - `canonicalJson(value: unknown): string`
  - `REVISION_CODECS = ["zstd", "raw"] as const`; `type RevisionCodec = "zstd" | "raw"`
  - `ZSTD_LEVEL = 10`
  - `type EncodedRevision = { readonly codec: RevisionCodec; readonly bytes: Buffer; readonly rawSize: number; readonly sha256: string }`
  - `encodeRevision(payload: unknown): EncodedRevision`
  - `decodeRevision(codec: RevisionCodec, bytes: Uint8Array): unknown`

- [ ] **Step 1: Nâng sàn Node**

Trong `testkite/package.json`, đổi `"node": ">=22"` thành `"node": ">=22.15.0"` (mốc zstd vào `node:zlib`). Không đụng `.github/workflows/testkite-ci.yml`: `node-version: '22'` đã lấy bản 22.x mới nhất.

- [ ] **Step 2: Viết test ĐỎ `apps/core/src/modules/authoring/revision/codec.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical.js";
import { decodeRevision, encodeRevision, ZSTD_LEVEL } from "./codec.js";

/** Payload case đủ lớn để zstd thắng — cùng hình dạng spike 2026-08-28. */
function bigPayload(n: number): { name: string; steps: { id: string; renderedSentence: string }[] } {
  const steps = [];
  for (let i = 1; i <= n; i++) {
    steps.push({
      id: `s${i}`,
      renderedSentence: `Enter "$secret:std_user_password" into the password field on the login page at step ${i}`,
    });
  }
  return { name: "Checkout — guest user", steps };
}

describe("canonicalJson", () => {
  it("sắp khoá object nên hai object khác thứ tự cho CÙNG chuỗi", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("GIỮ NGUYÊN thứ tự mảng — thứ tự step là dữ liệu, không phải nhiễu", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("sắp khoá ĐỆ QUY, kể cả object lồng trong mảng", () => {
    expect(canonicalJson({ x: [{ z: 1, y: 2 }] })).toBe('{"x":[{"y":2,"z":1}]}');
  });

  it("bỏ prop undefined thay vì ném — payload dựng từ DTO optional", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("từ chối số không hữu hạn — NaN/Infinity làm hash bất định", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/hữu hạn/);
  });
});

describe("encodeRevision", () => {
  it("nén zstd cho payload lớn và giảm ít nhất 5 lần", () => {
    const enc = encodeRevision(bigPayload(120));
    expect(enc.codec).toBe("zstd");
    expect(enc.bytes.length * 5).toBeLessThan(enc.rawSize);
  });

  it("blob mang magic number zstd 28 b5 2f fd", () => {
    const enc = encodeRevision(bigPayload(120));
    expect(enc.bytes.subarray(0, 4).toString("hex")).toBe("28b52ffd");
  });

  it("payload BÉ thì rơi về codec raw — nén làm nó phình ra (spike: 69B -> 78B)", () => {
    const enc = encodeRevision({ id: "x" });
    expect(enc.codec).toBe("raw");
    expect(enc.bytes.length).toBe(enc.rawSize);
  });

  it("rawSize là độ dài JSON canonical, không phải độ dài blob", () => {
    const payload = bigPayload(40);
    const enc = encodeRevision(payload);
    expect(enc.rawSize).toBe(Buffer.byteLength(canonicalJson(payload), "utf8"));
  });

  it("sha256 tính trên JSON canonical nên KHÔNG đổi khi hoán vị khoá", () => {
    const a = encodeRevision({ name: "n", steps: [] });
    const b = encodeRevision({ steps: [], name: "n" });
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("deterministic: nén hai lần ra ĐÚNG cùng byte (điều kiện của test golden)", () => {
    const p = bigPayload(40);
    expect(encodeRevision(p).bytes.equals(encodeRevision(p).bytes)).toBe(true);
  });

  it("mức nén chốt là 10", () => {
    expect(ZSTD_LEVEL).toBe(10);
  });
});

describe("decodeRevision", () => {
  it("round-trip zstd", () => {
    const p = bigPayload(40);
    const enc = encodeRevision(p);
    expect(decodeRevision(enc.codec, enc.bytes)).toEqual(p);
  });

  it("round-trip raw", () => {
    const enc = encodeRevision({ id: "x" });
    expect(decodeRevision(enc.codec, enc.bytes)).toEqual({ id: "x" });
  });

  it("nhận Uint8Array — PGlite trả bytea về dạng đó, KHÔNG phải Buffer", () => {
    const enc = encodeRevision(bigPayload(40));
    const asU8 = new Uint8Array(enc.bytes);
    expect(asU8 instanceof Buffer).toBe(false);
    expect(decodeRevision("zstd", asU8)).toEqual(bigPayload(40));
  });
});
```

- [ ] **Step 3: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm --filter @testkite/core test src/modules/authoring/revision/codec.test.ts`
Expected: FAIL — `Failed to resolve import "./canonical.js"`.

- [ ] **Step 4: Implement `apps/core/src/modules/authoring/revision/canonical.ts`**

```ts
/**
 * JSON canonical: khoá object sắp tăng dần, thứ tự MẢNG giữ nguyên.
 *
 * Vì sao cần: sha256 của revision phải ổn định giữa các lần chạy và giữa các
 * đường dựng payload khác nhau (đọc từ DB vs nhận từ HTTP). `JSON.stringify`
 * thường giữ thứ tự chèn khoá ⇒ cùng dữ liệu, khác hash. Thứ tự mảng thì
 * NGƯỢC LẠI: nó là dữ liệu nghiệp vụ (thứ tự step), sắp lại là làm hỏng case.
 */
function canonicalize(value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("canonicalJson: số không hữu hạn (NaN/Infinity) làm hash bất định");
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src).sort()) {
    const v = src[key];
    // exactOptionalPropertyTypes: DTO optional cho ra `undefined` thật —
    // bỏ hẳn khoá thay vì để JSON.stringify âm thầm bỏ, để hash khớp cả hai đường.
    if (v === undefined) continue;
    out[key] = canonicalize(v);
  }
  return out;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
```

- [ ] **Step 5: Implement `apps/core/src/modules/authoring/revision/codec.ts`**

```ts
/**
 * Codec revision — zstd NATIVE của Node (node:zlib), không thư viện ngoài.
 *
 * Spike 2026-08-28 (node v22.22.2), payload case 120 step:
 *   raw 34.019 B | zstd-3 2.278 B 0,53ms | zstd-10 1.868 B 0,83ms | zstd-19 1.824 B 28,50ms
 * ⇒ level 10: gần trần tỉ lệ nén, rẻ hơn level 19 tới 34 lần. Đây là đường ghi
 * ĐỒNG BỘ nằm trong transaction, mili-giây ở đây là mili-giây giữ khoá row.
 *
 * Payload bé PHÌNH RA khi nén (đo thật: 69 B -> 78 B) nên phải có nhánh 'raw'.
 */
import { createHash } from "node:crypto";
import zlib from "node:zlib";
import { canonicalJson } from "./canonical.js";

export const REVISION_CODECS = ["zstd", "raw"] as const;
export type RevisionCodec = (typeof REVISION_CODECS)[number];

export const ZSTD_LEVEL = 10;

export type EncodedRevision = {
  readonly codec: RevisionCodec;
  readonly bytes: Buffer;
  /** Độ dài JSON canonical (byte) TRƯỚC nén — cột payload_size của bảng revision. */
  readonly rawSize: number;
  /** sha256 hex của JSON canonical, KHÔNG phải của blob nén. */
  readonly sha256: string;
};

function assertZstd(): void {
  if (typeof zlib.zstdCompressSync !== "function") {
    throw new Error(
      "Node runtime thiếu zstd native trong node:zlib — cần Node >= 22.15.0 (xem engines.node)",
    );
  }
}

export function encodeRevision(payload: unknown): EncodedRevision {
  assertZstd();
  const json = canonicalJson(payload);
  const raw = Buffer.from(json, "utf8");
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const compressed = Buffer.from(
    zlib.zstdCompressSync(raw, { params: { [zlib.constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL } }),
  );
  if (compressed.length < raw.length) {
    return { codec: "zstd", bytes: compressed, rawSize: raw.length, sha256 };
  }
  return { codec: "raw", bytes: raw, rawSize: raw.length, sha256 };
}

/**
 * `bytes` nhận Uint8Array chứ không riêng Buffer: PGlite trả cột bytea về dạng
 * Uint8Array còn node-postgres trả Buffer (spike 2026-08-28). Không bao giờ
 * `instanceof Buffer` ở tầng này.
 */
export function decodeRevision(codec: RevisionCodec, bytes: Uint8Array): unknown {
  assertZstd();
  const buf = Buffer.from(bytes);
  const json = codec === "zstd" ? Buffer.from(zlib.zstdDecompressSync(buf)) : buf;
  return JSON.parse(json.toString("utf8")) as unknown;
}
```

- [ ] **Step 6: Chạy test, xác nhận XANH**

Run: `cd testkite && pnpm --filter @testkite/core test src/modules/authoring/revision/codec.test.ts`
Expected: PASS 14 test.

- [ ] **Step 7: Verify + commit**

Run: `cd testkite && pnpm typecheck && pnpm --filter @testkite/core test`
Expected: typecheck xanh; toàn bộ test cũ vẫn PASS.

```bash
git add testkite/apps/core/src/modules/authoring/revision/ testkite/package.json
git commit -m "M2-AUT T1: codec revision zstd native + canonical JSON"
```

---

## Task 2 — `aut_cases`: 5 timestamp workflow + status + version + `teams.allow_self_promote`

**Files:**
- Modify: `apps/core/src/modules/authoring/db/schema.ts` (mở rộng `aut_cases`, thêm enum `aut_case_status`)
- Modify: `apps/core/src/modules/identity/db/schema.ts` (thêm cột `allow_self_promote` vào `teams`)
- Modify: `apps/core/src/modules/identity/index.ts` (export `teams`)
- Create: `apps/core/drizzle/0007_authoring_workflow.sql` (sinh máy)
- Create: `apps/core/test/authoring/case-schema.test.ts`

**Interfaces:**
- Consumes: `autCases` (M1 T5), `projects`/`teams` từ facade identity, `appRole` từ facade kernel, `makeTestDb()`.
- Produces: enum `aut_case_status` (`draft` | `in_review` | `ready`); cột mới trên `aut_cases`: `status`, `version`, `latest_revision_id`, `ready_revision_id`, `last_edited_by`, `submitted_at`, `submitted_by`, `reviewed_at`, `reviewed_by`, `promoted_at`, `promoted_by`; CHECK `aut_cases_status_timeline`; cột `teams.allow_self_promote boolean NOT NULL DEFAULT false`; export `teams` từ `identity/index.ts`.

> **5 timestamp workflow** (blueprint §2 "vá dead-DTO cũ"): `created_at`, `updated_at` (đã có từ M1) + `submitted_at`, `reviewed_at`, `promoted_at`. Ba cái sau NULL khi chưa tới bước đó — và CHECK ép chúng khớp `status`, nên không thể tồn tại một case `ready` mà chưa từng được review (đúng thứ hệ cũ để lọt: `review_submitted_at` chưa từng persist — xem §8 câu hỏi mở #10).

- [ ] **Step 1: Viết test ĐỎ `apps/core/test/authoring/case-schema.test.ts`**

```ts
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../harness/pglite.js";

let t: TestDb;
let teamId = "";
let projectId = "";

beforeAll(async () => {
  t = await makeTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  const org = await t.db.execute(sql`INSERT INTO organizations (name, slug) VALUES ('Acme','acme') RETURNING id`);
  const orgId = String(org.rows[0]?.["id"]);
  const team = await t.db.execute(sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},'A','a') RETURNING id`);
  teamId = String(team.rows[0]?.["id"]);
  const proj = await t.db.execute(
    sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamId},'P','p') RETURNING id`,
  );
  projectId = String(proj.rows[0]?.["id"]);
});

describe("aut_cases — workflow columns", () => {
  it("aut_case_status là enum đúng 3 trạng thái", async () => {
    const r = await t.db.execute(sql`
      SELECT e.enumlabel FROM pg_enum e JOIN pg_type ty ON ty.oid = e.enumtypid
      WHERE ty.typname = 'aut_case_status' ORDER BY e.enumsortorder`);
    expect(r.rows.map((x) => x["enumlabel"])).toEqual(["draft", "in_review", "ready"]);
  });

  it("có đủ 5 timestamp workflow", async () => {
    const r = await t.db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'aut_cases' AND column_name LIKE '%_at'`);
    const cols = r.rows.map((x) => String(x["column_name"])).sort();
    expect(cols).toEqual(["created_at", "promoted_at", "reviewed_at", "submitted_at", "updated_at"]);
  });

  it("case mới mặc định draft, version = 1, ba timestamp sau NULL", async () => {
    const r = await t.db.execute(sql`
      INSERT INTO aut_cases (team_id, project_id, name) VALUES (${teamId}, ${projectId}, 'C1')
      RETURNING status, version, submitted_at, reviewed_at, promoted_at`);
    const row = r.rows[0];
    expect(row?.["status"]).toBe("draft");
    expect(Number(row?.["version"])).toBe(1);
    expect(row?.["submitted_at"]).toBeNull();
    expect(row?.["reviewed_at"]).toBeNull();
    expect(row?.["promoted_at"]).toBeNull();
  });

  it("CHECK chặn status=in_review khi submitted_at NULL", async () => {
    await expect(
      t.db.execute(sql`
        INSERT INTO aut_cases (team_id, project_id, name, status)
        VALUES (${teamId}, ${projectId}, 'C2', 'in_review')`),
    ).rejects.toThrow(/aut_cases_status_timeline|check constraint/i);
  });

  it("CHECK chặn status=ready khi thiếu promoted_at", async () => {
    await expect(
      t.db.execute(sql`
        INSERT INTO aut_cases (team_id, project_id, name, status, submitted_at, reviewed_at)
        VALUES (${teamId}, ${projectId}, 'C3', 'ready', now(), now())`),
    ).rejects.toThrow(/aut_cases_status_timeline|check constraint/i);
  });

  it("CHECK chặn version <= 0", async () => {
    await expect(
      t.db.execute(sql`
        INSERT INTO aut_cases (team_id, project_id, name, version)
        VALUES (${teamId}, ${projectId}, 'C4', 0)`),
    ).rejects.toThrow(/version|check constraint/i);
  });

  it("teams.allow_self_promote mặc định FALSE — four-eyes bật sẵn, phải TỰ TAY tắt", async () => {
    const r = await t.db.execute(sql`SELECT allow_self_promote FROM teams WHERE id = ${teamId}`);
    expect(r.rows[0]?.["allow_self_promote"]).toBe(false);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm --filter @testkite/core test test/authoring/case-schema.test.ts`
Expected: FAIL ngay test đầu — `pg_type` không có `aut_case_status` (0 row).

- [ ] **Step 3: Thêm cột vào `teams` (module identity)**

Trong `apps/core/src/modules/identity/db/schema.ts`, thêm import `boolean`:

```ts
import { boolean, index, pgEnum, pgPolicy, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
```

và thêm **một dòng vào CUỐI** danh sách cột của `teams` (ngay sau `createdAt`), không đụng dòng nào khác:

```ts
    /**
     * Four-eyes (blueprint §3): mặc định người-sửa-cuối KHÔNG được tự promote.
     * Team một người / team pilot bật cờ này để tự promote — quyết định của
     * team_admin, ghi audit, không phải mặc định im lặng.
     */
    allowSelfPromote: boolean("allow_self_promote").notNull().default(false),
```

Trong `apps/core/src/modules/identity/index.ts`, sửa dòng export cuối thành:

```ts
export { projects, teams } from "./db/schema.js";
```

- [ ] **Step 4: Mở rộng `aut_cases` trong `apps/core/src/modules/authoring/db/schema.ts`**

Đổi khối import đầu file thành (thêm `check`, `integer`, `pgEnum`):

```ts
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "../../identity/index.js";
import { appRole } from "../../kernel/index.js";
```

Thêm ngay dưới `const tenantPredicate = ...`:

```ts
/** Máy trạng thái review: draft -> in_review -> ready. Không có đường tắt. */
export const autCaseStatus = pgEnum("aut_case_status", ["draft", "in_review", "ready"]);
```

Thêm các cột sau vào object cột của `autCases` (ngay sau `updatedAt`):

```ts
    status: autCaseStatus("status").notNull().default("draft"),
    /** Optimistic concurrency: nguồn của ETag. Mọi mutation +1, không bao giờ lùi. */
    version: integer("version").notNull().default(1),
    /**
     * Ghim revision (blueprint §4 phase 1): schedule/CI compile bản `ready`,
     * ad-hoc của tác giả compile bản `latest`. FK composite được thêm ở Task 4
     * (bảng aut_case_revisions chưa tồn tại ở migration này).
     */
    latestRevisionId: uuid("latest_revision_id"),
    readyRevisionId: uuid("ready_revision_id"),
    /** Four-eyes so người promote với CHÍNH cột này. */
    lastEditedBy: uuid("last_edited_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    submittedBy: uuid("submitted_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: uuid("reviewed_by"),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    promotedBy: uuid("promoted_by"),
```

và thêm hai CHECK vào cuối mảng cấu hình (TRƯỚC `pgPolicy`, thứ tự không ảnh hưởng SQL nhưng giữ policy ở cuối cho dễ đọc):

```ts
    check("aut_cases_version_positive", sql`version > 0`),
    /**
     * Timeline không thể giả mạo: mỗi trạng thái đòi đúng bộ dấu thời gian của nó.
     * Hệ cũ để lọt case "ready" mà review_submitted_at chưa từng được ghi
     * (blueprint §8 #10) — CHECK này làm lớp lỗi đó không viết ra được.
     */
    check(
      "aut_cases_status_timeline",
      sql`(status = 'draft')
       OR (status = 'in_review' AND submitted_at IS NOT NULL)
       OR (status = 'ready' AND submitted_at IS NOT NULL AND reviewed_at IS NOT NULL
           AND promoted_at IS NOT NULL AND ready_revision_id IS NOT NULL)`,
    ),
```

- [ ] **Step 5: Sinh migration**

Run: `cd testkite/apps/core && pnpm db:generate --name=authoring_workflow`
Expected: `drizzle/0007_authoring_workflow.sql` (số có thể khác — xem mục "Phụ thuộc chéo"). Mở file, xác nhận có `CREATE TYPE "public"."aut_case_status"`, `ALTER TABLE "teams" ADD COLUMN "allow_self_promote" boolean DEFAULT false NOT NULL`, và hai `ADD CONSTRAINT ... CHECK`.

Không cần migration grants ở task này: cột mới nằm trong bảng đã `GRANT SELECT, INSERT, UPDATE, DELETE` từ `0002`/`0004`.

- [ ] **Step 6: Chạy test, xác nhận XANH**

Run: `cd testkite && pnpm --filter @testkite/core test test/authoring/case-schema.test.ts`
Expected: PASS 6 test.

- [ ] **Step 7: Verify + commit**

Run: `cd testkite && pnpm typecheck && pnpm --filter @testkite/core test`
Expected: toàn bộ xanh (test M1 không đổi hành vi — cột mới đều có default hoặc nullable).

```bash
git add testkite/apps/core/src/modules/authoring/db/schema.ts \
        testkite/apps/core/src/modules/identity/db/schema.ts \
        testkite/apps/core/src/modules/identity/index.ts \
        testkite/apps/core/drizzle/ testkite/apps/core/test/authoring/case-schema.test.ts
git commit -m "M2-AUT T2: aut_cases 5 timestamp workflow + version + allow_self_promote"
```

---

## Task 3 — `aut_steps` + `aut_step_loops` + `aut_rest_steps` (6 kind khớp contract)

**Files:**
- Modify: `apps/core/src/modules/authoring/db/schema.ts`
- Create: `apps/core/drizzle/0008_aut_steps.sql` (sinh máy)
- Create: `apps/core/drizzle/0009_aut_steps_grants.sql` (viết tay)
- Create: `apps/core/test/authoring/step-schema.test.ts`

**Interfaces:**
- Consumes: `autCases` (Task 2), `appRole`.
- Produces: enum `aut_step_kind` (`action`|`step_group`|`if`|`for`|`while`|`rest` — ĐÚNG `STEP_KINDS` của `packages/contract/src/schemas/step.ts`); bảng `autSteps`, `autStepLoops`, `autRestSteps`; CHECK `aut_steps_kind_shape`.

> **Quyết định chuẩn hoá (đọc trước khi code):** chi tiết vòng lặp nằm **chỉ** trong `aut_step_loops` (1:1 với step `for`/`while` — chính là `for_step_conditions` của hệ cũ, blueprint §2), chi tiết REST nằm **chỉ** trong `aut_rest_steps`. `aut_steps` giữ phần chung + phần `action`/`step_group`/`if`. Nhờ vậy CHECK `aut_steps_kind_shape` chỉ nói về các cột có mặt, và không có cột nào bị nhân đôi giữa hai bảng. Sự **có mặt** của row 1:1 do service bảo đảm (Task 5) + compiler chẩn đoán — không dùng trigger.
>
> `element_id` và `loop_data_profile_id` **chưa có FK** ở M2: `elm_elements` và `tdt_profiles` ra đời ở M4. Giữ nguyên kiểu `uuid` và thêm FK composite ở M4. Đây là thiếu sót *có chủ đích và có hẹn*, không phải quên.
>
> `subscription_id` (XOR với `step_group_case_id`, blueprint §2) thuộc phần **sharing** (`step_group_subscriptions`) — ngoài phạm vi M2, xem Self-Review.

- [ ] **Step 1: Viết test ĐỎ `apps/core/test/authoring/step-schema.test.ts`**

```ts
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { STEP_KINDS } from "@testkite/contract";
import { makeTestDb, type TestDb } from "../harness/pglite.js";

let t: TestDb;
let teamId = "";
let otherTeamId = "";
let projectId = "";
let caseId = "";

beforeAll(async () => {
  t = await makeTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  const org = await t.db.execute(sql`INSERT INTO organizations (name, slug) VALUES ('Acme','acme') RETURNING id`);
  const orgId = String(org.rows[0]?.["id"]);
  const a = await t.db.execute(sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},'A','a') RETURNING id`);
  const b = await t.db.execute(sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},'B','b') RETURNING id`);
  teamId = String(a.rows[0]?.["id"]);
  otherTeamId = String(b.rows[0]?.["id"]);
  const p = await t.db.execute(sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamId},'P','p') RETURNING id`);
  projectId = String(p.rows[0]?.["id"]);
  const c = await t.db.execute(
    sql`INSERT INTO aut_cases (team_id, project_id, name) VALUES (${teamId},${projectId},'C') RETURNING id`,
  );
  caseId = String(c.rows[0]?.["id"]);
});

describe("aut_steps — hình dạng", () => {
  it("enum aut_step_kind khớp CHÍNH XÁC STEP_KINDS của contract", async () => {
    const r = await t.db.execute(sql`
      SELECT e.enumlabel FROM pg_enum e JOIN pg_type ty ON ty.oid = e.enumtypid
      WHERE ty.typname = 'aut_step_kind' ORDER BY e.enumsortorder`);
    expect(r.rows.map((x) => x["enumlabel"])).toEqual([...STEP_KINDS]);
  });

  it("nhận step action hợp lệ", async () => {
    const r = await t.db.execute(sql`
      INSERT INTO aut_steps (team_id, case_id, ordinal, kind, rendered_sentence, verb_op_key)
      VALUES (${teamId},${caseId},1,'action','Click on login','click') RETURNING id`);
    expect(String(r.rows[0]?.["id"])).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("CHECK chặn action KHÔNG có verb_op_key", async () => {
    await expect(
      t.db.execute(sql`
        INSERT INTO aut_steps (team_id, case_id, ordinal, kind, rendered_sentence)
        VALUES (${teamId},${caseId},1,'action','Click on login')`),
    ).rejects.toThrow(/aut_steps_kind_shape|check constraint/i);
  });

  it("CHECK chặn step_group mang verb_op_key (lẫn cột của kind khác)", async () => {
    await expect(
      t.db.execute(sql`
        INSERT INTO aut_steps (team_id, case_id, ordinal, kind, rendered_sentence, step_group_case_id, verb_op_key)
        VALUES (${teamId},${caseId},1,'step_group','Call login group',${caseId},'click')`),
    ).rejects.toThrow(/aut_steps_kind_shape|check constraint/i);
  });

  it("CHECK chặn if KHÔNG có condition_expected", async () => {
    await expect(
      t.db.execute(sql`
        INSERT INTO aut_steps (team_id, case_id, ordinal, kind, rendered_sentence)
        VALUES (${teamId},${caseId},1,'if','If previous succeeded')`),
    ).rejects.toThrow(/aut_steps_kind_shape|check constraint/i);
  });

  it("nhận for/while/rest — chi tiết nằm ở bảng 1:1, aut_steps chỉ giữ phần chung", async () => {
    for (const [i, kind] of (["for", "while", "rest"] as const).entries()) {
      await t.db.execute(sql`
        INSERT INTO aut_steps (team_id, case_id, ordinal, kind, rendered_sentence)
        VALUES (${teamId},${caseId},${i + 1},${kind},'sentence')`);
    }
    const r = await t.db.execute(sql`SELECT count(*)::int AS n FROM aut_steps WHERE case_id = ${caseId}`);
    expect(r.rows[0]?.["n"]).toBe(3);
  });

  it("UNIQUE (team_id, case_id, parent_step_id, ordinal) NULLS NOT DISTINCT — hai step gốc cùng ordinal bị chặn", async () => {
    await t.db.execute(sql`
      INSERT INTO aut_steps (team_id, case_id, ordinal, kind, rendered_sentence, verb_op_key)
      VALUES (${teamId},${caseId},1,'action','s1','click')`);
    await expect(
      t.db.execute(sql`
        INSERT INTO aut_steps (team_id, case_id, ordinal, kind, rendered_sentence, verb_op_key)
        VALUES (${teamId},${caseId},1,'action','s2','click')`),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("composite FK chặn step trỏ case của tenant khác", async () => {
    await expect(
      t.db.execute(sql`
        INSERT INTO aut_steps (team_id, case_id, ordinal, kind, rendered_sentence, verb_op_key)
        VALUES (${otherTeamId},${caseId},1,'action','s','click')`),
    ).rejects.toThrow(/foreign key/i);
  });

  it("xoá case CASCADE xuống steps", async () => {
    await t.db.execute(sql`
      INSERT INTO aut_steps (team_id, case_id, ordinal, kind, rendered_sentence, verb_op_key)
      VALUES (${teamId},${caseId},1,'action','s','click')`);
    await t.db.execute(sql`DELETE FROM aut_cases WHERE id = ${caseId}`);
    const r = await t.db.execute(sql`SELECT count(*)::int AS n FROM aut_steps`);
    expect(r.rows[0]?.["n"]).toBe(0);
  });
});

describe("aut_step_loops / aut_rest_steps — 1:1", () => {
  async function mkStep(kind: string): Promise<string> {
    const r = await t.db.execute(sql`
      INSERT INTO aut_steps (team_id, case_id, ordinal, kind, rendered_sentence)
      VALUES (${teamId},${caseId},1,${kind},'sentence') RETURNING id`);
    return String(r.rows[0]?.["id"]);
  }

  it("aut_step_loops UNIQUE theo step — không thể gắn 2 cấu hình vòng lặp cho 1 step", async () => {
    const stepId = await mkStep("for");
    await t.db.execute(sql`
      INSERT INTO aut_step_loops (team_id, step_id, data_profile_id)
      VALUES (${teamId},${stepId},gen_random_uuid())`);
    await expect(
      t.db.execute(sql`
        INSERT INTO aut_step_loops (team_id, step_id, data_profile_id)
        VALUES (${teamId},${stepId},gen_random_uuid())`),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("aut_rest_steps UNIQUE theo step + CASCADE khi xoá step", async () => {
    const stepId = await mkStep("rest");
    await t.db.execute(sql`
      INSERT INTO aut_rest_steps (team_id, step_id, method, url)
      VALUES (${teamId},${stepId},'POST','https://example.test/api/v1/orders')`);
    await t.db.execute(sql`DELETE FROM aut_steps WHERE id = ${stepId}`);
    const r = await t.db.execute(sql`SELECT count(*)::int AS n FROM aut_rest_steps`);
    expect(r.rows[0]?.["n"]).toBe(0);
  });
});

describe("RLS + GRANT cho 3 bảng step", () => {
  it("cả 3 bảng bật row security", async () => {
    const r = await t.db.execute(sql`
      SELECT relname, relrowsecurity FROM pg_class
      WHERE relname IN ('aut_steps','aut_step_loops','aut_rest_steps') AND relkind='r'`);
    expect(r.rows.length).toBe(3);
    for (const row of r.rows) expect(row["relrowsecurity"]).toBe(true);
  });

  it("role app đọc được step của team mình và KHÔNG thấy team khác", async () => {
    await t.db.execute(sql`
      INSERT INTO aut_steps (team_id, case_id, ordinal, kind, rendered_sentence, verb_op_key)
      VALUES (${teamId},${caseId},1,'action','mine','click')`);
    await t.raw.exec(`SET ROLE testkite_app`);
    await t.raw.query(`SELECT set_config('app.team_id', $1, false)`, [teamId]);
    const mine = await t.raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM aut_steps`);
    await t.raw.query(`SELECT set_config('app.team_id', $1, false)`, [otherTeamId]);
    const theirs = await t.raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM aut_steps`);
    await t.raw.exec(`RESET ROLE`);
    await t.raw.exec(`RESET app.team_id`);
    expect(mine.rows[0]?.n).toBe(1);
    expect(theirs.rows[0]?.n).toBe(0);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm --filter @testkite/core test test/authoring/step-schema.test.ts`
Expected: FAIL — `relation "aut_steps" does not exist`.

- [ ] **Step 3: Thêm 3 bảng vào `apps/core/src/modules/authoring/db/schema.ts`**

Thêm vào cuối file:

```ts
/**
 * 6 kind KHỚP CHÍNH XÁC `STEP_KINDS` của packages/contract/src/schemas/step.ts.
 * Lệch một nhãn là hợp đồng API nói dối về thứ DB chấp nhận.
 */
export const autStepKind = pgEnum("aut_step_kind", [
  "action",
  "step_group",
  "if",
  "for",
  "while",
  "rest",
]);

export const autSteps = pgTable(
  "aut_steps",
  {
    teamId: uuid("team_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id").notNull(),
    /** if/for/while lồng cây: con trỏ về step cha, NULL = step gốc của case. */
    parentStepId: uuid("parent_step_id"),
    ordinal: integer("ordinal").notNull(),
    kind: autStepKind("kind").notNull(),
    renderedSentence: text("rendered_sentence").notNull(),
    /** kind=action */
    verbOpKey: text("verb_op_key"),
    /** kind=action — FK sang elm_elements thêm ở M4 (bảng chưa tồn tại). */
    elementId: uuid("element_id"),
    /** kind=action|rest — bản đồ chuỗi→chuỗi; secret đi dạng `$secret:<name>`. */
    args: jsonb("args"),
    /** kind=step_group — case có is_step_group = true. */
    stepGroupCaseId: uuid("step_group_case_id"),
    /** kind=if — ví dụ {SUCCESS}. */
    conditionExpected: text("condition_expected").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("aut_steps_team_id_unique").on(t.teamId, t.id),
    /**
     * NULLS NOT DISTINCT: parent_step_id NULL nghĩa là "step gốc" — với ngữ nghĩa
     * NULL mặc định của Postgres thì hai step gốc cùng ordinal LỌT qua unique.
     * (drizzle 0.45.2 có .nullsNotDistinct() — đã kiểm chứng 2026-08-28.)
     */
    unique("aut_steps_position_unique")
      .on(t.teamId, t.caseId, t.parentStepId, t.ordinal)
      .nullsNotDistinct(),
    index("aut_steps_team_case_idx").on(t.teamId, t.caseId, t.ordinal),
    foreignKey({
      name: "aut_steps_case_fk",
      columns: [t.teamId, t.caseId],
      foreignColumns: [autCases.teamId, autCases.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "aut_steps_parent_fk",
      columns: [t.teamId, t.parentStepId],
      foreignColumns: [t.teamId, t.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "aut_steps_step_group_fk",
      columns: [t.teamId, t.stepGroupCaseId],
      foreignColumns: [autCases.teamId, autCases.id],
    }),
    check("aut_steps_ordinal_positive", sql`ordinal > 0`),
    /**
     * DB cưỡng chế union rẽ nhánh theo `kind` — đúng cái discriminatedUnion của
     * zod cưỡng chế ở biên API. Hai đầu cùng luật thì không có đường nào lọt.
     * for/while/rest KHÔNG có cột riêng ở đây: chi tiết nằm ở bảng 1:1.
     */
    check(
      "aut_steps_kind_shape",
      sql`(kind = 'action'     AND verb_op_key IS NOT NULL AND step_group_case_id IS NULL AND condition_expected IS NULL)
       OR (kind = 'step_group' AND step_group_case_id IS NOT NULL AND verb_op_key IS NULL AND element_id IS NULL AND args IS NULL AND condition_expected IS NULL)
       OR (kind = 'if'         AND condition_expected IS NOT NULL AND array_length(condition_expected, 1) >= 1 AND verb_op_key IS NULL AND step_group_case_id IS NULL AND element_id IS NULL)
       OR (kind IN ('for','while') AND verb_op_key IS NULL AND step_group_case_id IS NULL AND condition_expected IS NULL AND element_id IS NULL)
       OR (kind = 'rest'       AND verb_op_key IS NULL AND step_group_case_id IS NULL AND condition_expected IS NULL AND element_id IS NULL)`,
    ),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: appRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
  ],
).enableRLS();

/**
 * 1:1 với step kind for/while — hậu duệ của `for_step_conditions` hệ cũ
 * (blueprint §2: engine loop THẬT, không phải 3 cột vestigial trên aut_steps).
 * FK sang tdt_profiles thêm ở M4.
 */
export const autStepLoops = pgTable(
  "aut_step_loops",
  {
    teamId: uuid("team_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    stepId: uuid("step_id").notNull(),
    dataProfileId: uuid("data_profile_id"),
    /** kind=while: NULL là dữ liệu hợp lệ — COMPILER phán (diagnostic while_without_max_iterations). */
    maxIterations: integer("max_iterations"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("aut_step_loops_team_id_unique").on(t.teamId, t.id),
    unique("aut_step_loops_step_unique").on(t.teamId, t.stepId),
    index("aut_step_loops_team_idx").on(t.teamId, t.stepId),
    foreignKey({
      name: "aut_step_loops_step_fk",
      columns: [t.teamId, t.stepId],
      foreignColumns: [autSteps.teamId, autSteps.id],
    }).onDelete("cascade"),
    check("aut_step_loops_max_iterations_positive", sql`max_iterations IS NULL OR max_iterations > 0`),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: appRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
  ],
).enableRLS();

/** 1:1 với step kind rest. */
export const autRestSteps = pgTable(
  "aut_rest_steps",
  {
    teamId: uuid("team_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    stepId: uuid("step_id").notNull(),
    method: text("method").notNull(),
    url: text("url").notNull(),
    headers: jsonb("headers"),
    body: text("body"),
    /** Tên biến hứng kết quả, ví dụ `orderId` → dùng lại bằng @{orderId}. */
    storeAs: text("store_as"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("aut_rest_steps_team_id_unique").on(t.teamId, t.id),
    unique("aut_rest_steps_step_unique").on(t.teamId, t.stepId),
    index("aut_rest_steps_team_idx").on(t.teamId, t.stepId),
    foreignKey({
      name: "aut_rest_steps_step_fk",
      columns: [t.teamId, t.stepId],
      foreignColumns: [autSteps.teamId, autSteps.id],
    }).onDelete("cascade"),
    check(
      "aut_rest_steps_method_known",
      sql`method IN ('GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS')`,
    ),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: appRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
  ],
).enableRLS();
```

Thêm `jsonb` vào khối import của file (`import { boolean, check, foreignKey, index, integer, jsonb, pgEnum, pgPolicy, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";`).

- [ ] **Step 4: Sinh migration + viết tay grants**

Run: `cd testkite/apps/core && pnpm db:generate --name=aut_steps`

Tạo `apps/core/drizzle/0009_aut_steps_grants.sql`:

```sql
-- Phần drizzle-kit KHÔNG sinh: GRANT (xem 0002_rls_hardening.sql).
-- RLS chỉ lọc row SAU KHI role đã có quyền trên bảng; thiếu GRANT thì testkite_app
-- nhận "permission denied" — không phải fail-closed đúng nghĩa.
GRANT SELECT, INSERT, UPDATE, DELETE ON aut_steps TO "testkite_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON aut_step_loops TO "testkite_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON aut_rest_steps TO "testkite_app";
```

Thêm entry vào `apps/core/drizzle/meta/_journal.json` (copy entry cuối, `idx` +1, `"tag": "0009_aut_steps_grants"`, `"when"` = `node -e "console.log(Date.now())"`).

- [ ] **Step 5: Chạy test, xác nhận XANH**

Run: `cd testkite && pnpm --filter @testkite/core test test/authoring/step-schema.test.ts`
Expected: PASS 13 test.

- [ ] **Step 6: Verify + commit**

Run: `cd testkite && pnpm typecheck && pnpm --filter @testkite/core test`

```bash
git add testkite/apps/core/src/modules/authoring/db/schema.ts testkite/apps/core/drizzle/ \
        testkite/apps/core/test/authoring/step-schema.test.ts
git commit -m "M2-AUT T3: aut_steps 6 kind + aut_step_loops + aut_rest_steps"
```

---

## Task 4 — `aut_case_revisions`: append-only cưỡng chế bằng GRANT

**Files:**
- Modify: `apps/core/src/modules/authoring/db/schema.ts` (bảng + `bytea` customType + 2 FK từ `aut_cases`)
- Create: `apps/core/drizzle/0010_aut_case_revisions.sql` (sinh máy)
- Create: `apps/core/drizzle/0011_aut_case_revisions_grants.sql` (viết tay — **chỉ SELECT + INSERT**)
- Create: `apps/core/test/authoring/revision-schema.test.ts`

**Interfaces:**
- Consumes: `autCases` (Task 2), `encodeRevision()` (Task 1).
- Produces: `bytea` (customType), bảng `autCaseRevisions` với cột `revisionNo`, `caseVersion`, `codec`, `payload`, `payloadSize`, `payloadSha256`, `createdBy`, `note`; FK composite `aut_cases.(team_id, latest_revision_id)` và `(team_id, ready_revision_id)` → `aut_case_revisions(team_id, id)`.

> **`case_version` là cột quyết định** của optimistic concurrency: khi client gửi `If-Match: "7"`, server tìm revision có `case_version = 7` để lấy **base** của diff 3 chiều (Task 6/7). Không có cột này thì 409 chỉ nói được "lệch" mà không nói được "lệch ở đâu".

- [ ] **Step 1: Viết test ĐỎ `apps/core/test/authoring/revision-schema.test.ts`**

```ts
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { decodeRevision, encodeRevision } from "../../src/modules/authoring/revision/codec.js";
import { makeTestDb, type TestDb } from "../harness/pglite.js";

let t: TestDb;
let teamId = "";
let caseId = "";

beforeAll(async () => {
  t = await makeTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  const org = await t.db.execute(sql`INSERT INTO organizations (name, slug) VALUES ('Acme','acme') RETURNING id`);
  const orgId = String(org.rows[0]?.["id"]);
  const team = await t.db.execute(sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},'A','a') RETURNING id`);
  teamId = String(team.rows[0]?.["id"]);
  const p = await t.db.execute(sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamId},'P','p') RETURNING id`);
  const projectId = String(p.rows[0]?.["id"]);
  const c = await t.db.execute(
    sql`INSERT INTO aut_cases (team_id, project_id, name) VALUES (${teamId},${projectId},'C') RETURNING id`,
  );
  caseId = String(c.rows[0]?.["id"]);
});

const PAYLOAD = {
  case: { name: "Checkout", isStepGroup: false },
  steps: Array.from({ length: 60 }, (_, i) => ({
    id: `s${i + 1}`,
    kind: "action",
    after: i === 0 ? null : `s${i}`,
    renderedSentence: `Enter "$secret:std_user_password" into the password field at step ${i + 1}`,
    verbOpKey: "type",
  })),
};

describe("aut_case_revisions — lưu trữ", () => {
  it("round-trip blob zstd qua bytea", async () => {
    const enc = encodeRevision(PAYLOAD);
    await t.db.execute(sql`
      INSERT INTO aut_case_revisions
        (team_id, case_id, revision_no, case_version, codec, payload, payload_size, payload_sha256)
      VALUES (${teamId},${caseId},1,1,${enc.codec},${enc.bytes},${enc.rawSize},${enc.sha256})`);
    const r = await t.db.execute(sql`
      SELECT codec, payload, payload_size, payload_sha256 FROM aut_case_revisions WHERE case_id = ${caseId}`);
    const row = r.rows[0];
    expect(row?.["codec"]).toBe("zstd");
    expect(Number(row?.["payload_size"])).toBe(enc.rawSize);
    expect(row?.["payload_sha256"]).toBe(enc.sha256);
    // PGlite trả bytea về Uint8Array — decode phải chịu được kiểu đó.
    expect(decodeRevision("zstd", row?.["payload"] as Uint8Array)).toEqual(PAYLOAD);
  });

  it("blob nhỏ hơn payload gốc ít nhất 5 lần (bằng chứng nén thật sự có tác dụng)", async () => {
    const enc = encodeRevision(PAYLOAD);
    await t.db.execute(sql`
      INSERT INTO aut_case_revisions
        (team_id, case_id, revision_no, case_version, codec, payload, payload_size, payload_sha256)
      VALUES (${teamId},${caseId},1,1,${enc.codec},${enc.bytes},${enc.rawSize},${enc.sha256})`);
    const r = await t.db.execute(sql`
      SELECT octet_length(payload)::int AS blob, payload_size FROM aut_case_revisions WHERE case_id = ${caseId}`);
    const blob = Number(r.rows[0]?.["blob"]);
    expect(blob * 5).toBeLessThan(Number(r.rows[0]?.["payload_size"]));
  });

  it("UNIQUE (team_id, case_id, revision_no) — không có hai revision cùng số", async () => {
    const enc = encodeRevision(PAYLOAD);
    const ins = sql`
      INSERT INTO aut_case_revisions
        (team_id, case_id, revision_no, case_version, codec, payload, payload_size, payload_sha256)
      VALUES (${teamId},${caseId},1,1,${enc.codec},${enc.bytes},${enc.rawSize},${enc.sha256})`;
    await t.db.execute(ins);
    await expect(t.db.execute(ins)).rejects.toThrow(/duplicate key|unique/i);
  });

  it("CHECK chặn codec lạ", async () => {
    await expect(
      t.db.execute(sql`
        INSERT INTO aut_case_revisions
          (team_id, case_id, revision_no, case_version, codec, payload, payload_size, payload_sha256)
        VALUES (${teamId},${caseId},1,1,'brotli','\\x00'::bytea,10,repeat('a',64))`),
    ).rejects.toThrow(/codec|check constraint/i);
  });

  it("CHECK chặn sha256 không phải 64 hex", async () => {
    await expect(
      t.db.execute(sql`
        INSERT INTO aut_case_revisions
          (team_id, case_id, revision_no, case_version, codec, payload, payload_size, payload_sha256)
        VALUES (${teamId},${caseId},1,1,'raw','\\x00'::bytea,10,'khong-phai-hash')`),
    ).rejects.toThrow(/sha256|check constraint/i);
  });
});

describe("APPEND-ONLY — cưỡng chế bằng quyền Postgres, không bằng quy ước", () => {
  async function seedRevision(): Promise<void> {
    const enc = encodeRevision(PAYLOAD);
    await t.db.execute(sql`
      INSERT INTO aut_case_revisions
        (team_id, case_id, revision_no, case_version, codec, payload, payload_size, payload_sha256)
      VALUES (${teamId},${caseId},1,1,${enc.codec},${enc.bytes},${enc.rawSize},${enc.sha256})`);
  }

  it("role app KHÔNG có grant UPDATE trên aut_case_revisions", async () => {
    const r = await t.db.execute(sql`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'testkite_app' AND table_name = 'aut_case_revisions'
      ORDER BY privilege_type`);
    expect(r.rows.map((x) => x["privilege_type"])).toEqual(["INSERT", "SELECT"]);
  });

  it("UPDATE dưới role app bị Postgres từ chối", async () => {
    await seedRevision();
    await t.raw.exec(`SET ROLE testkite_app`);
    await t.raw.query(`SELECT set_config('app.team_id', $1, false)`, [teamId]);
    await expect(t.raw.query(`UPDATE aut_case_revisions SET note = 'tampered'`)).rejects.toThrow(
      /permission denied/i,
    );
    await t.raw.exec(`RESET ROLE`);
    await t.raw.exec(`RESET app.team_id`);
  });

  it("DELETE dưới role app bị Postgres từ chối", async () => {
    await seedRevision();
    await t.raw.exec(`SET ROLE testkite_app`);
    await t.raw.query(`SELECT set_config('app.team_id', $1, false)`, [teamId]);
    await expect(t.raw.query(`DELETE FROM aut_case_revisions`)).rejects.toThrow(/permission denied/i);
    await t.raw.exec(`RESET ROLE`);
    await t.raw.exec(`RESET app.team_id`);
  });

  it("INSERT + SELECT dưới role app vẫn chạy (append-only, không phải read-only)", async () => {
    const enc = encodeRevision(PAYLOAD);
    await t.raw.exec(`SET ROLE testkite_app`);
    await t.raw.query(`SELECT set_config('app.team_id', $1, false)`, [teamId]);
    await t.raw.query(
      `INSERT INTO aut_case_revisions
         (team_id, case_id, revision_no, case_version, codec, payload, payload_size, payload_sha256)
       VALUES ($1,$2,1,1,$3,$4,$5,$6)`,
      [teamId, caseId, enc.codec, enc.bytes, enc.rawSize, enc.sha256],
    );
    const r = await t.raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM aut_case_revisions`);
    await t.raw.exec(`RESET ROLE`);
    await t.raw.exec(`RESET app.team_id`);
    expect(r.rows[0]?.n).toBe(1);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm --filter @testkite/core test test/authoring/revision-schema.test.ts`
Expected: FAIL — `relation "aut_case_revisions" does not exist`.

- [ ] **Step 3: Khai `bytea` + bảng revision trong `apps/core/src/modules/authoring/db/schema.ts`**

Thêm `customType` vào import từ `drizzle-orm/pg-core`, rồi thêm ngay dưới `tenantPredicate`:

```ts
/**
 * drizzle-orm 0.45.2 KHÔNG có kiểu `bytea` (kiểm chứng 2026-08-28) — tự khai.
 * fromDriver phải chịu được CẢ HAI driver: node-postgres trả Buffer, PGlite trả
 * Uint8Array. `Buffer.from` xử lý cả hai và luôn trả Buffer.
 */
export const bytea = customType<{ data: Buffer; driverData: Uint8Array }>({
  dataType() {
    return "bytea";
  },
  toDriver(value: Buffer): Uint8Array {
    return value;
  },
  fromDriver(value: Uint8Array): Buffer {
    return Buffer.from(value);
  },
});
```

Thêm bảng (sau `autRestSteps`):

```ts
/**
 * Ảnh chụp BẤT BIẾN của case. APPEND-ONLY: role app chỉ có GRANT SELECT + INSERT
 * (migration *_aut_case_revisions_grants.sql) — Postgres từ chối UPDATE/DELETE,
 * nên "lịch sử không sửa được" là một quyền, không phải một lời hứa.
 */
export const autCaseRevisions = pgTable(
  "aut_case_revisions",
  {
    teamId: uuid("team_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id").notNull(),
    /** Đếm từ 1 trong phạm vi từng case. */
    revisionNo: integer("revision_no").notNull(),
    /**
     * Giá trị aut_cases.version TẠI thời điểm chụp. Đây là móc để dựng BASE của
     * diff 3 chiều: `If-Match: "7"` ⇒ tìm revision có case_version = 7.
     */
    caseVersion: integer("case_version").notNull(),
    codec: text("codec").notNull(),
    payload: bytea("payload").notNull(),
    /** Độ dài JSON canonical TRƯỚC nén. */
    payloadSize: integer("payload_size").notNull(),
    /** sha256 hex của JSON canonical (không phải của blob) — dedup + toàn vẹn. */
    payloadSha256: text("payload_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
    note: text("note"),
  },
  (t) => [
    unique("aut_case_revisions_team_id_unique").on(t.teamId, t.id),
    unique("aut_case_revisions_no_unique").on(t.teamId, t.caseId, t.revisionNo),
    index("aut_case_revisions_case_version_idx").on(t.teamId, t.caseId, t.caseVersion),
    foreignKey({
      name: "aut_case_revisions_case_fk",
      columns: [t.teamId, t.caseId],
      foreignColumns: [autCases.teamId, autCases.id],
    }).onDelete("cascade"),
    check("aut_case_revisions_codec_known", sql`codec IN ('zstd','raw')`),
    check("aut_case_revisions_no_positive", sql`revision_no > 0 AND case_version > 0`),
    check("aut_case_revisions_sha256_hex", sql`payload_sha256 ~ '^[0-9a-f]{64}$'`),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: appRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
  ],
).enableRLS();
```

Thêm hai FK composite từ `aut_cases` vào cuối mảng cấu hình của `autCases` (đặt TRƯỚC `pgPolicy`):

```ts
    foreignKey({
      name: "aut_cases_latest_revision_fk",
      columns: [t.teamId, t.latestRevisionId],
      foreignColumns: [autCaseRevisions.teamId, autCaseRevisions.id],
    }),
    foreignKey({
      name: "aut_cases_ready_revision_fk",
      columns: [t.teamId, t.readyRevisionId],
      foreignColumns: [autCaseRevisions.teamId, autCaseRevisions.id],
    }),
```

> Vòng FK hai chiều `aut_cases ⇄ aut_case_revisions` là hợp lệ: drizzle-kit sinh composite FK bằng `ALTER TABLE ... ADD CONSTRAINT` sau khi cả hai bảng đã tồn tại, và thứ tự ghi lúc chạy là *case trước (revision id NULL) → revision → UPDATE case*.

- [ ] **Step 4: Sinh migration + viết tay grants append-only**

Run: `cd testkite/apps/core && pnpm db:generate --name=aut_case_revisions`

Tạo `apps/core/drizzle/0011_aut_case_revisions_grants.sql`:

```sql
-- APPEND-ONLY. Cố tình KHÔNG có UPDATE, KHÔNG có DELETE.
-- Đây là toàn bộ cơ chế bảo vệ lịch sử revision: quyền Postgres, không phải code
-- ứng dụng. Spike 2026-08-28 xác nhận GRANT SELECT,INSERT rồi UPDATE dưới role app
-- cho "permission denied for table". Ai muốn xoá lịch sử phải là owner DB —
-- và việc đó để lại dấu ở tầng hạ tầng, không lọt qua một bug API.
GRANT SELECT, INSERT ON aut_case_revisions TO "testkite_app";
```

Thêm entry `_journal.json` như Task 3 Step 4 (`"tag": "0011_aut_case_revisions_grants"`).

- [ ] **Step 5: Chạy test, xác nhận XANH**

Run: `cd testkite && pnpm --filter @testkite/core test test/authoring/revision-schema.test.ts`
Expected: PASS 9 test.

- [ ] **Step 6: Verify + commit**

Run: `cd testkite && pnpm typecheck && pnpm --filter @testkite/core test`

```bash
git add testkite/apps/core/src/modules/authoring/db/schema.ts testkite/apps/core/drizzle/ \
        testkite/apps/core/test/authoring/revision-schema.test.ts
git commit -m "M2-AUT T4: aut_case_revisions append-only zstd (grant SELECT+INSERT)"
```

---

## Task 5 — DTO contract authoring (zod) + sinh lại OpenAPI

**Files:**
- Create: `packages/contract/src/schemas/authoring.ts`
- Create: `packages/contract/src/schemas/authoring.test.ts`
- Modify: `packages/contract/src/schemas/index.ts`
- Modify: `packages/contract/src/openapi.ts`
- Modify: `packages/contract/openapi.json` (sinh lại)

**Interfaces:**
- Consumes: `STEP_KINDS` (`./step.js`).
- Produces:
  - `CASE_STATUSES = ["draft","in_review","ready"] as const`; `caseStatusSchema`; `type CaseStatusDto`
  - `REVIEW_DECISIONS = ["approved","changes_requested"] as const`; `reviewDecisionSchema`; `type ReviewDecisionDto`
  - `stepInputSchema: z.ZodType<StepInputDto>` + `type StepInputDto` (6 kind, **có `id` optional**, **không có `ordinal`**)
  - `caseSummarySchema` + `type CaseSummaryDto`
  - `CHANGE_KINDS = ["added","removed","modified"] as const`; `caseChangeSchema` + `type CaseChangeDto`
  - `threeWayDiffSchema` + `type ThreeWayDiffDto`

> **Vì sao `StepInput` KHÔNG dùng lại `AuthoredStep`:** hai DTO phục vụ hai chiều khác nhau. `AuthoredStep` là thứ **compiler đọc** — không có id (compiler không cần), có `ordinal` (đã hoá giải thành số). `StepInput` là thứ **tác giả gửi lên** — phải có `id` optional để server giữ nguyên danh tính step qua các lần sửa (nếu không, mọi lần lưu sinh id mới ⇒ diff 3 chiều báo "thay toàn bộ case", đúng lớp nhiễu mà spike đã đo), và KHÔNG có `ordinal` vì vị trí = thứ tự phần tử trong mảng, để client không bao giờ gửi lên một bộ ordinal tự mâu thuẫn.

- [ ] **Step 1: Viết test ĐỎ `packages/contract/src/schemas/authoring.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { STEP_KINDS } from "./step.js";
import {
  CASE_STATUSES,
  CHANGE_KINDS,
  REVIEW_DECISIONS,
  caseSummarySchema,
  stepInputSchema,
  threeWayDiffSchema,
} from "./authoring.js";

describe("stepInputSchema", () => {
  it("phủ đúng 6 kind của STEP_KINDS — không thừa, không thiếu", () => {
    const ok = STEP_KINDS.every((kind) => {
      const base = { kind, renderedSentence: "s" } as Record<string, unknown>;
      if (kind === "action") base["verbOpKey"] = "click";
      if (kind === "step_group") base["stepGroupCaseId"] = "c1";
      if (kind === "if") { base["conditionExpected"] = ["SUCCESS"]; base["children"] = []; }
      if (kind === "for") { base["loopDataProfileId"] = "d1"; base["children"] = []; }
      if (kind === "while") base["children"] = [];
      return stepInputSchema.safeParse(base).success;
    });
    expect(ok).toBe(true);
  });

  it("KHÔNG nhận ordinal — vị trí là thứ tự mảng, client không được tự đánh số", () => {
    const r = stepInputSchema.safeParse({ kind: "action", renderedSentence: "s", verbOpKey: "click", ordinal: 3 });
    expect(r.success).toBe(true);
    if (!r.success) throw new Error("unreachable");
    expect("ordinal" in r.data).toBe(false);
  });

  it("id là optional — step mới chưa có id, step cũ echo id về để giữ danh tính", () => {
    expect(stepInputSchema.safeParse({ kind: "action", renderedSentence: "s", verbOpKey: "click" }).success).toBe(true);
    expect(
      stepInputSchema.safeParse({ id: "s1", kind: "action", renderedSentence: "s", verbOpKey: "click" }).success,
    ).toBe(true);
  });

  it("từ chối action thiếu verbOpKey", () => {
    expect(stepInputSchema.safeParse({ kind: "action", renderedSentence: "s" }).success).toBe(false);
  });

  it("children đệ quy đúng — if lồng for lồng action", () => {
    const r = stepInputSchema.safeParse({
      kind: "if",
      renderedSentence: "if ok",
      conditionExpected: ["SUCCESS"],
      children: [
        {
          kind: "for",
          renderedSentence: "for each row",
          loopDataProfileId: "d1",
          children: [{ kind: "action", renderedSentence: "click", verbOpKey: "click" }],
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("rest nhận method/url", () => {
    expect(
      stepInputSchema.safeParse({
        kind: "rest",
        renderedSentence: "POST /orders",
        method: "POST",
        url: "https://x.test/orders",
      }).success,
    ).toBe(true);
  });
});

describe("caseSummarySchema", () => {
  it("version là số nguyên dương và status thuộc CASE_STATUSES", () => {
    const r = caseSummarySchema.safeParse({
      id: "c1",
      projectId: "p1",
      name: "Checkout",
      isStepGroup: false,
      status: "draft",
      version: 1,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    });
    expect(r.success).toBe(true);
    expect(CASE_STATUSES).toEqual(["draft", "in_review", "ready"]);
    expect(caseSummarySchema.safeParse({ id: "c1", projectId: "p1", name: "n", isStepGroup: false, status: "draft", version: 0, createdAt: "x", updatedAt: "x" }).success).toBe(false);
  });
});

describe("threeWayDiffSchema", () => {
  it("nhận body 409 đầy đủ ba nhánh + danh sách conflict", () => {
    const r = threeWayDiffSchema.safeParse({
      baseVersion: 7,
      baseRevisionId: "r7",
      currentVersion: 9,
      currentRevisionId: "r9",
      mine: [{ path: "/steps/s9", kind: "added" }],
      theirs: [{ path: "/name", kind: "modified" }],
      conflicts: [],
    });
    expect(r.success).toBe(true);
  });

  it("kind chỉ nhận added|removed|modified", () => {
    expect(CHANGE_KINDS).toEqual(["added", "removed", "modified"]);
    const r = threeWayDiffSchema.safeParse({
      baseVersion: 1, baseRevisionId: "r1", currentVersion: 2, currentRevisionId: "r2",
      mine: [{ path: "/x", kind: "renamed" }], theirs: [], conflicts: [],
    });
    expect(r.success).toBe(false);
  });

  it("REVIEW_DECISIONS đúng 2 lựa chọn — không có 'promoted' (promote là bước riêng)", () => {
    expect(REVIEW_DECISIONS).toEqual(["approved", "changes_requested"]);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm --filter @testkite/contract test`
Expected: FAIL — `Failed to resolve import "./authoring.js"`.

- [ ] **Step 3: Implement `packages/contract/src/schemas/authoring.ts`**

```ts
/**
 * DTO authoring-facing cho VÒNG ĐỜI case (khác `./case.js` — cái đó là DTO cho
 * COMPILER đọc). Hai chiều, hai hình dạng:
 *   - AuthoredStep  (./step.js) : compiler đọc — có `ordinal`, không có `id`.
 *   - StepInput     (file này)  : tác giả gửi — có `id` optional, KHÔNG có `ordinal`.
 * `id` optional là thứ giữ danh tính step qua các lần sửa; thiếu nó thì diff 3 chiều
 * báo "thay toàn bộ case" mỗi lần lưu (đã đo trong spike 2026-08-28).
 */
import { z } from "zod";

export const CASE_STATUSES = ["draft", "in_review", "ready"] as const;
export const caseStatusSchema = z.enum(CASE_STATUSES);
export type CaseStatusDto = (typeof CASE_STATUSES)[number];

export const REVIEW_DECISIONS = ["approved", "changes_requested"] as const;
export const reviewDecisionSchema = z.enum(REVIEW_DECISIONS);
export type ReviewDecisionDto = (typeof REVIEW_DECISIONS)[number];

export const CHANGE_KINDS = ["added", "removed", "modified"] as const;
export const changeKindSchema = z.enum(CHANGE_KINDS);
export type ChangeKindDto = (typeof CHANGE_KINDS)[number];

const argsSchema = z.record(z.string());

export interface ActionStepInputDto {
  id?: string | undefined;
  kind: "action";
  renderedSentence: string;
  verbOpKey: string;
  args?: Record<string, string> | undefined;
  elementId?: string | undefined;
}
export interface StepGroupStepInputDto {
  id?: string | undefined;
  kind: "step_group";
  renderedSentence: string;
  stepGroupCaseId: string;
}
export interface IfStepInputDto {
  id?: string | undefined;
  kind: "if";
  renderedSentence: string;
  conditionExpected: string[];
  children: StepInputDto[];
}
export interface ForStepInputDto {
  id?: string | undefined;
  kind: "for";
  renderedSentence: string;
  loopDataProfileId: string;
  children: StepInputDto[];
}
export interface WhileStepInputDto {
  id?: string | undefined;
  kind: "while";
  renderedSentence: string;
  /** Không bắt buộc ở biên API — COMPILER phán (diagnostic while_without_max_iterations). */
  maxIterations?: number | undefined;
  children: StepInputDto[];
}
export interface RestStepInputDto {
  id?: string | undefined;
  kind: "rest";
  renderedSentence: string;
  method: string;
  url: string;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
  storeAs?: string | undefined;
}

export type StepInputDto =
  | ActionStepInputDto
  | StepGroupStepInputDto
  | IfStepInputDto
  | ForStepInputDto
  | WhileStepInputDto
  | RestStepInputDto;

const inputCommon = {
  id: z.string().min(1).optional(),
  renderedSentence: z.string().min(1),
};

export const stepInputSchema: z.ZodType<StepInputDto> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("action"),
      ...inputCommon,
      verbOpKey: z.string().min(1),
      args: argsSchema.optional(),
      elementId: z.string().min(1).optional(),
    }),
    z.object({ kind: z.literal("step_group"), ...inputCommon, stepGroupCaseId: z.string().min(1) }),
    z.object({
      kind: z.literal("if"),
      ...inputCommon,
      conditionExpected: z.array(z.string().min(1)).min(1),
      children: z.array(stepInputSchema),
    }),
    z.object({
      kind: z.literal("for"),
      ...inputCommon,
      loopDataProfileId: z.string().min(1),
      children: z.array(stepInputSchema),
    }),
    z.object({
      kind: z.literal("while"),
      ...inputCommon,
      maxIterations: z.number().int().positive().optional(),
      children: z.array(stepInputSchema),
    }),
    z.object({
      kind: z.literal("rest"),
      ...inputCommon,
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
      url: z.string().min(1),
      headers: argsSchema.optional(),
      body: z.string().optional(),
      storeAs: z.string().min(1).optional(),
    }),
  ]),
);

/** Thân phản hồi của GET/POST case. `version` là nguồn của ETag. */
export const caseSummarySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1),
  isStepGroup: z.boolean(),
  status: caseStatusSchema,
  version: z.number().int().positive(),
  prereqCaseId: z.string().min(1).optional(),
  dataProfileId: z.string().min(1).optional(),
  latestRevisionId: z.string().min(1).optional(),
  readyRevisionId: z.string().min(1).optional(),
  lastEditedBy: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  submittedAt: z.string().min(1).optional(),
  reviewedAt: z.string().min(1).optional(),
  promotedAt: z.string().min(1).optional(),
});

export interface CaseSummaryDto {
  id: string;
  projectId: string;
  name: string;
  isStepGroup: boolean;
  status: CaseStatusDto;
  version: number;
  prereqCaseId?: string | undefined;
  dataProfileId?: string | undefined;
  latestRevisionId?: string | undefined;
  readyRevisionId?: string | undefined;
  lastEditedBy?: string | undefined;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string | undefined;
  reviewedAt?: string | undefined;
  promotedAt?: string | undefined;
}

/**
 * Một thay đổi = một ĐƯỜNG DẪN. `/name`, `/steps/<stepId>` (thêm/xoá cả step),
 * `/steps/<stepId>/<field>` (sửa một trường). `after` là một field hợp lệ: nó mang
 * vị trí (id step liền trước) thay cho ordinal số — nhờ vậy chèn 1 step chỉ sinh
 * 2 mục thay vì 4 (đo thật trong spike 2026-08-28).
 */
export const caseChangeSchema = z.object({
  path: z.string().min(1),
  kind: changeKindSchema,
  base: z.unknown().optional(),
  value: z.unknown().optional(),
});

export interface CaseChangeDto {
  path: string;
  kind: ChangeKindDto;
  base?: unknown;
  value?: unknown;
}

/** Thân phản hồi 409: ba mốc + hai nhánh thay đổi + giao của chúng. */
export const threeWayDiffSchema = z.object({
  baseVersion: z.number().int().positive(),
  baseRevisionId: z.string().min(1),
  currentVersion: z.number().int().positive(),
  currentRevisionId: z.string().min(1),
  /** base → bản client gửi lên. */
  mine: z.array(caseChangeSchema),
  /** base → bản đang nằm trên server. */
  theirs: z.array(caseChangeSchema),
  /** Đường dẫn xuất hiện ở CẢ HAI nhánh — chỗ người dùng phải tự quyết. */
  conflicts: z.array(z.string().min(1)),
});

export interface ThreeWayDiffDto {
  baseVersion: number;
  baseRevisionId: string;
  currentVersion: number;
  currentRevisionId: string;
  mine: CaseChangeDto[];
  theirs: CaseChangeDto[];
  conflicts: string[];
}
```

- [ ] **Step 4: Nối vào barrel + OpenAPI**

`packages/contract/src/schemas/index.ts` — thêm dòng CUỐI:

```ts
export * from "./authoring.js";
```

`packages/contract/src/openapi.ts` — thêm vào import từ `./schemas/index.js`: `caseChangeSchema, caseSummarySchema, stepInputSchema, threeWayDiffSchema`; thêm **VÀO CUỐI** `OPENAPI_SCHEMA_NAMES`:

```ts
  "StepInput",
  "CaseSummary",
  "CaseChange",
  "ThreeWayDiff",
```

và **vào cuối** object `components.schemas` trong `buildOpenApiDocument()`:

```ts
        StepInput: stepInputSchema,
        CaseSummary: caseSummarySchema,
        CaseChange: caseChangeSchema,
        ThreeWayDiff: threeWayDiffSchema,
```

> Thêm vào CUỐI là bắt buộc: `openapi.json` được so **theo byte** trong gate drift, và thứ tự khoá quyết định byte.

- [ ] **Step 5: Chạy test, xác nhận XANH + sinh lại spec**

Run: `cd testkite && pnpm --filter @testkite/contract test`
Expected: PASS (10 test mới + toàn bộ test cũ của contract).

Run: `cd testkite && pnpm openapi:gen && pnpm openapi:check`
Expected: `openapi.json` có thêm 4 schema; `openapi:check` xanh (không diff sau khi commit file mới sinh).

- [ ] **Step 6: Commit**

```bash
git add testkite/packages/contract/src/schemas/authoring.ts \
        testkite/packages/contract/src/schemas/authoring.test.ts \
        testkite/packages/contract/src/schemas/index.ts \
        testkite/packages/contract/src/openapi.ts testkite/packages/contract/openapi.json
git commit -m "M2-AUT T5: DTO authoring (StepInput/CaseSummary/ThreeWayDiff) + regen OpenAPI"
```

---

## Task 6 — Revision payload + diff 3 chiều (thuần, không I/O)

**Files:**
- Create: `apps/core/src/modules/authoring/revision/payload.ts`
- Create: `apps/core/src/modules/authoring/revision/diff.ts`
- Create: `apps/core/src/modules/authoring/revision/diff.test.ts`

**Interfaces:**
- Consumes: `CaseChangeDto`, `ThreeWayDiffDto` (Task 5).
- Produces:
  - `type RevisionStep = { readonly id: string; readonly kind: StepKindDto; readonly parentId: string | null; readonly after: string | null; readonly renderedSentence: string; readonly verbOpKey?: string; readonly elementId?: string; readonly args?: Record<string,string>; readonly stepGroupCaseId?: string; readonly conditionExpected?: readonly string[]; readonly loop?: { readonly dataProfileId?: string; readonly maxIterations?: number }; readonly rest?: { readonly method: string; readonly url: string; readonly headers?: Record<string,string>; readonly body?: string; readonly storeAs?: string } }`
  - `type RevisionPayload = { readonly case: { readonly name: string; readonly isStepGroup: boolean; readonly prereqCaseId?: string; readonly dataProfileId?: string }; readonly steps: readonly RevisionStep[] }`
  - `flattenRevision(p: RevisionPayload): FlatRevision` với `type FlatRevision = { readonly scalars: ReadonlyMap<string, string>; readonly steps: ReadonlyMap<string, ReadonlyMap<string, string>> }`
  - `diffFlat(a: FlatRevision, b: FlatRevision): CaseChangeDto[]`
  - `threeWayDiff(args: { base: RevisionPayload; mine: RevisionPayload; theirs: RevisionPayload; baseVersion: number; baseRevisionId: string; currentVersion: number; currentRevisionId: string }): ThreeWayDiffDto`

> **Luật chuẩn hoá (đây là toàn bộ giá trị của hàm này):** vị trí step KHÔNG được biểu diễn bằng số. `after` = id của step liền trước **cùng cha** (null nếu đứng đầu). Spike 2026-08-28 đo: chèn 1 step vào giữa 4 step ⇒ jsondiffpatch/rfc6902/deep-object-diff đều báo **4** thay đổi (3 cái là giả); chuẩn hoá `after` + khoá theo id ⇒ đúng **2** mục (`/steps/s9` added, `/steps/s2/after` modified).

- [ ] **Step 1: Viết test ĐỎ `apps/core/src/modules/authoring/revision/diff.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import type { RevisionPayload, RevisionStep } from "./payload.js";
import { diffFlat, flattenRevision, threeWayDiff } from "./diff.js";

function step(id: string, after: string | null, sentence: string): RevisionStep {
  return {
    id,
    kind: "action",
    parentId: null,
    after,
    renderedSentence: sentence,
    verbOpKey: "click",
  };
}

const BASE: RevisionPayload = {
  case: { name: "Checkout", isStepGroup: false },
  steps: [
    step("s1", null, "open login page"),
    step("s2", "s1", "type username"),
    step("s3", "s2", "type password"),
    step("s4", "s3", "click submit"),
  ],
};

/** Chèn s9 vào giữa: chỉ s2 đổi `after`, không step nào khác động đậy. */
const MINE: RevisionPayload = {
  case: { name: "Checkout", isStepGroup: false },
  steps: [
    step("s1", null, "open login page"),
    step("s9", "s1", "accept cookie banner"),
    step("s2", "s9", "type username"),
    step("s3", "s2", "type password"),
    step("s4", "s3", "click submit"),
  ],
};

const THEIRS: RevisionPayload = {
  case: { name: "Checkout v2", isStepGroup: false },
  steps: [
    step("s1", null, "open login page"),
    step("s2", "s1", "type username"),
    step("s3", "s2", "type password"),
    step("s4", "s3", "click the submit button"),
  ],
};

describe("flattenRevision", () => {
  it("gom scalar của case và bản đồ field theo id step", () => {
    const f = flattenRevision(BASE);
    expect(f.scalars.get("/name")).toBe('"Checkout"');
    expect(f.steps.size).toBe(4);
    expect(f.steps.get("s2")?.get("after")).toBe('"s1"');
    expect(f.steps.get("s1")?.get("after")).toBe("null");
  });

  it("KHÔNG đưa ordinal vào bản phẳng — vị trí chỉ tồn tại dưới dạng `after`", () => {
    const f = flattenRevision(BASE);
    for (const fields of f.steps.values()) expect(fields.has("ordinal")).toBe(false);
  });
});

describe("diffFlat — nhiễu bằng 0 khi chèn step", () => {
  it("chèn ĐÚNG 1 step sinh ĐÚNG 2 mục (spike: thư viện ngoài sinh 4)", () => {
    const d = diffFlat(flattenRevision(BASE), flattenRevision(MINE));
    expect(d).toEqual([
      { path: "/steps/s2/after", kind: "modified", base: "s1", value: "s9" },
      { path: "/steps/s9", kind: "added", value: MINE.steps[1] },
    ]);
  });

  it("sửa tên case + câu của 1 step sinh đúng 2 mục", () => {
    const d = diffFlat(flattenRevision(BASE), flattenRevision(THEIRS));
    expect(d.map((c) => c.path)).toEqual(["/name", "/steps/s4/renderedSentence"]);
    expect(d.every((c) => c.kind === "modified")).toBe(true);
  });

  it("xoá step báo removed ở CẤP STEP, không vỡ thành từng field", () => {
    const shorter: RevisionPayload = {
      case: BASE.case,
      steps: [step("s1", null, "open login page"), step("s3", "s1", "type password"), step("s4", "s3", "click submit")],
    };
    const d = diffFlat(flattenRevision(BASE), flattenRevision(shorter));
    expect(d.filter((c) => c.kind === "removed").map((c) => c.path)).toEqual(["/steps/s2"]);
  });

  it("payload y hệt ⇒ diff rỗng", () => {
    expect(diffFlat(flattenRevision(BASE), flattenRevision(BASE))).toEqual([]);
  });

  it("kết quả sắp theo path — body 409 ổn định giữa hai lần chạy", () => {
    const d = diffFlat(flattenRevision(BASE), flattenRevision(MINE));
    expect([...d].sort((a, b) => (a.path < b.path ? -1 : 1))).toEqual(d);
  });
});

describe("threeWayDiff", () => {
  const meta = { baseVersion: 7, baseRevisionId: "r7", currentVersion: 9, currentRevisionId: "r9" };

  it("hai bên sửa chỗ khác nhau ⇒ conflicts rỗng", () => {
    const r = threeWayDiff({ base: BASE, mine: MINE, theirs: THEIRS, ...meta });
    expect(r.mine).toHaveLength(2);
    expect(r.theirs).toHaveLength(2);
    expect(r.conflicts).toEqual([]);
    expect(r.baseVersion).toBe(7);
    expect(r.currentRevisionId).toBe("r9");
  });

  it("hai bên cùng sửa MỘT field ⇒ path đó nằm trong conflicts", () => {
    const mine2: RevisionPayload = {
      case: BASE.case,
      steps: [...BASE.steps.slice(0, 3), step("s4", "s3", "tap submit")],
    };
    const theirs2: RevisionPayload = {
      case: BASE.case,
      steps: [...BASE.steps.slice(0, 3), step("s4", "s3", "press the submit control")],
    };
    const r = threeWayDiff({ base: BASE, mine: mine2, theirs: theirs2, ...meta });
    expect(r.conflicts).toEqual(["/steps/s4/renderedSentence"]);
  });

  it("hai bên sửa GIỐNG HỆT nhau ⇒ KHÔNG phải conflict (cùng đích đến)", () => {
    const same: RevisionPayload = {
      case: BASE.case,
      steps: [...BASE.steps.slice(0, 3), step("s4", "s3", "tap submit")],
    };
    const r = threeWayDiff({ base: BASE, mine: same, theirs: same, ...meta });
    expect(r.conflicts).toEqual([]);
  });

  it("xoá ở một bên và sửa ở bên kia CÙNG step ⇒ conflict ở cấp step", () => {
    const deleted: RevisionPayload = { case: BASE.case, steps: [...BASE.steps.slice(0, 3)] };
    const edited: RevisionPayload = {
      case: BASE.case,
      steps: [...BASE.steps.slice(0, 3), step("s4", "s3", "tap submit")],
    };
    const r = threeWayDiff({ base: BASE, mine: deleted, theirs: edited, ...meta });
    expect(r.conflicts).toContain("/steps/s4");
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm --filter @testkite/core test src/modules/authoring/revision/diff.test.ts`
Expected: FAIL — `Failed to resolve import "./payload.js"`.

- [ ] **Step 3: Implement `apps/core/src/modules/authoring/revision/payload.ts`**

```ts
/**
 * Hình dạng ảnh chụp lưu trong `aut_case_revisions.payload` (sau canonical + zstd).
 *
 * KHÔNG có `ordinal`: vị trí được mã hoá bằng `after` = id step liền trước CÙNG CHA.
 * Lý do đo được (spike 2026-08-28): ordinal là số nên chèn một step làm đánh số lại
 * cả đuôi ⇒ mọi thuật toán diff báo N thay đổi cho 1 hành động. Với `after`, chèn
 * một step chỉ chạm đúng hai mục.
 */
import type { StepKindDto } from "@testkite/contract";

export interface RevisionLoop {
  readonly dataProfileId?: string;
  readonly maxIterations?: number;
}

export interface RevisionRest {
  readonly method: string;
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly storeAs?: string;
}

export interface RevisionStep {
  readonly id: string;
  readonly kind: StepKindDto;
  /** null = step gốc của case. */
  readonly parentId: string | null;
  /** null = step đầu tiên trong danh sách anh em. */
  readonly after: string | null;
  readonly renderedSentence: string;
  readonly verbOpKey?: string;
  readonly elementId?: string;
  readonly args?: Record<string, string>;
  readonly stepGroupCaseId?: string;
  readonly conditionExpected?: readonly string[];
  readonly loop?: RevisionLoop;
  readonly rest?: RevisionRest;
}

export interface RevisionCase {
  readonly name: string;
  readonly isStepGroup: boolean;
  readonly prereqCaseId?: string;
  readonly dataProfileId?: string;
}

export interface RevisionPayload {
  readonly case: RevisionCase;
  /** Danh sách PHẲNG mọi step (kể cả step con) — cây dựng lại từ parentId + after. */
  readonly steps: readonly RevisionStep[];
}
```

- [ ] **Step 4: Implement `apps/core/src/modules/authoring/revision/diff.ts`**

```ts
/**
 * Diff 3 chiều cho payload revision. THUẦN — không I/O, không Date.now().
 *
 * Vì sao TỰ VIẾT thay vì lấy thư viện (khảo sát 2026-08-28):
 *   - Không thư viện npm nào cho diff 3 chiều dạng BÁO CÁO; `json-diff3` (thư viện
 *     merge 3 chiều duy nhất) băm phần tử mảng bằng String(obj) nên ném cứng
 *     "Duplicate array key '[object Object]'" trên đúng hình dạng steps của ta.
 *   - Mọi thư viện 2 chiều (jsondiffpatch, rfc6902, fast-json-patch, deep-object-diff)
 *     báo 4 thay đổi cho 1 lần chèn step; phần chuẩn hoá triệt tiêu nhiễu vẫn phải
 *     tự làm, sau đó thư viện chỉ còn làm vòng for.
 *   - Body 409 phải là DTO có zod schema (gate drift OpenAPI) — định dạng delta
 *     ma thuật của jsondiffpatch không diễn đạt được thành schema tử tế.
 */
import type { CaseChangeDto, ThreeWayDiffDto } from "@testkite/contract";
import { canonicalJson } from "./canonical.js";
import type { RevisionPayload, RevisionStep } from "./payload.js";

export interface FlatRevision {
  /** path -> JSON canonical của giá trị. Ví dụ "/name" -> "\"Checkout\"". */
  readonly scalars: ReadonlyMap<string, string>;
  /** stepId -> (field -> JSON canonical). */
  readonly steps: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

const CASE_FIELDS = ["name", "isStepGroup", "prereqCaseId", "dataProfileId"] as const;
const STEP_FIELDS = [
  "kind",
  "parentId",
  "after",
  "renderedSentence",
  "verbOpKey",
  "elementId",
  "args",
  "stepGroupCaseId",
  "conditionExpected",
  "loop",
  "rest",
] as const;

export function flattenRevision(payload: RevisionPayload): FlatRevision {
  const scalars = new Map<string, string>();
  for (const field of CASE_FIELDS) {
    const value = payload.case[field];
    if (value === undefined) continue;
    scalars.set(`/${field}`, canonicalJson(value));
  }
  const steps = new Map<string, ReadonlyMap<string, string>>();
  for (const step of payload.steps) {
    const fields = new Map<string, string>();
    for (const field of STEP_FIELDS) {
      const value = step[field];
      if (value === undefined) continue;
      fields.set(field, canonicalJson(value));
    }
    steps.set(step.id, fields);
  }
  return { scalars, steps };
}

/** Chỉ dùng cho `base`/`value` của DTO — trả về giá trị đã parse, không phải chuỗi JSON. */
function parse(json: string | undefined): unknown {
  return json === undefined ? undefined : (JSON.parse(json) as unknown);
}

function change(path: string, kind: CaseChangeDto["kind"], base?: string, value?: string): CaseChangeDto {
  const out: CaseChangeDto = { path, kind };
  const b = parse(base);
  const v = parse(value);
  // exactOptionalPropertyTypes: gán undefined tường minh là lỗi kiểu — chỉ gán khi có.
  return {
    ...out,
    ...(b === undefined ? {} : { base: b }),
    ...(v === undefined ? {} : { value: v }),
  };
}

/** So hai bản phẳng. Thêm/xoá báo ở CẤP STEP; sửa báo ở cấp FIELD. */
export function diffFlat(a: FlatRevision, b: FlatRevision): CaseChangeDto[] {
  const out: CaseChangeDto[] = [];

  for (const path of new Set([...a.scalars.keys(), ...b.scalars.keys()])) {
    const x = a.scalars.get(path);
    const y = b.scalars.get(path);
    if (x === y) continue;
    if (x === undefined) out.push(change(path, "added", undefined, y));
    else if (y === undefined) out.push(change(path, "removed", x, undefined));
    else out.push(change(path, "modified", x, y));
  }

  for (const id of new Set([...a.steps.keys(), ...b.steps.keys()])) {
    const x = a.steps.get(id);
    const y = b.steps.get(id);
    if (x !== undefined && y === undefined) {
      out.push({ path: `/steps/${id}`, kind: "removed", base: rebuild(x) });
      continue;
    }
    if (x === undefined && y !== undefined) {
      out.push({ path: `/steps/${id}`, kind: "added", value: rebuild(y, id) });
      continue;
    }
    if (x === undefined || y === undefined) continue;
    for (const field of new Set([...x.keys(), ...y.keys()])) {
      const fx = x.get(field);
      const fy = y.get(field);
      if (fx === fy) continue;
      const path = `/steps/${id}/${field}`;
      if (fx === undefined) out.push(change(path, "added", undefined, fy));
      else if (fy === undefined) out.push(change(path, "removed", fx, undefined));
      else out.push(change(path, "modified", fx, fy));
    }
  }

  // Thứ tự ổn định: body 409 phải giống nhau giữa hai lần chạy (test + client cache).
  return out.sort((p, q) => (p.path < q.path ? -1 : p.path > q.path ? 1 : 0));
}

/** Dựng lại object step từ bản phẳng để đưa vào `base`/`value` của mục added/removed. */
function rebuild(fields: ReadonlyMap<string, string>, id?: string): unknown {
  const out: Record<string, unknown> = {};
  if (id !== undefined) out["id"] = id;
  for (const [k, v] of fields) out[k] = JSON.parse(v) as unknown;
  return out;
}

export interface ThreeWayDiffInput {
  readonly base: RevisionPayload;
  readonly mine: RevisionPayload;
  readonly theirs: RevisionPayload;
  readonly baseVersion: number;
  readonly baseRevisionId: string;
  readonly currentVersion: number;
  readonly currentRevisionId: string;
}

/**
 * Conflict = path bị CẢ HAI nhánh chạm tới VÀ đi tới hai giá trị khác nhau.
 * Hai bên sửa giống hệt nhau thì không có gì phải quyết ⇒ không tính conflict.
 * Xoá một bên + sửa bên kia rơi vào cùng path cấp step `/steps/<id>` ở nhánh xoá và
 * path cấp field ở nhánh sửa — nên so cả hai chiều bằng tiền tố.
 */
export function threeWayDiff(input: ThreeWayDiffInput): ThreeWayDiffDto {
  const base = flattenRevision(input.base);
  const mine = diffFlat(base, flattenRevision(input.mine));
  const theirs = diffFlat(base, flattenRevision(input.theirs));

  const theirsByPath = new Map(theirs.map((c) => [c.path, c]));
  const conflicts: string[] = [];
  for (const m of mine) {
    const t = theirsByPath.get(m.path);
    if (t !== undefined) {
      if (canonicalJson(m.value) !== canonicalJson(t.value)) conflicts.push(m.path);
      continue;
    }
    // Nhánh này xoá cả step, nhánh kia sửa field bên trong nó (hoặc ngược lại).
    if (m.kind === "removed" && theirs.some((c) => c.path.startsWith(`${m.path}/`))) {
      conflicts.push(m.path);
    }
  }
  for (const t of theirs) {
    if (t.kind !== "removed") continue;
    if (conflicts.includes(t.path)) continue;
    if (mine.some((c) => c.path.startsWith(`${t.path}/`))) conflicts.push(t.path);
  }

  return {
    baseVersion: input.baseVersion,
    baseRevisionId: input.baseRevisionId,
    currentVersion: input.currentVersion,
    currentRevisionId: input.currentRevisionId,
    mine,
    theirs,
    conflicts: conflicts.sort(),
  };
}
```

- [ ] **Step 5: Chạy test, xác nhận XANH**

Run: `cd testkite && pnpm --filter @testkite/core test src/modules/authoring/revision/diff.test.ts`
Expected: PASS 12 test.

- [ ] **Step 6: Verify + commit**

Run: `cd testkite && pnpm typecheck && pnpm --filter @testkite/core test`

```bash
git add testkite/apps/core/src/modules/authoring/revision/payload.ts \
        testkite/apps/core/src/modules/authoring/revision/diff.ts \
        testkite/apps/core/src/modules/authoring/revision/diff.test.ts
git commit -m "M2-AUT T6: diff 3 chieu thuan (chuan hoa after thay ordinal)"
```

---

## Task 7 — Optimistic concurrency: `ETag` / `If-Match` + taxonomy lỗi authoring

**Files:**
- Create: `apps/core/src/modules/authoring/concurrency.ts`
- Create: `apps/core/src/modules/authoring/errors.ts`
- Create: `apps/core/src/modules/authoring/concurrency.test.ts`

**Interfaces:**
- Consumes: `ThreeWayDiffDto` (Task 5).
- Produces:
  - `formatETag(version: number): string` — trả `"7"` (có dấu nháy kép, đúng RFC 9110 entity-tag)
  - `parseIfMatch(header: string | undefined): number` — ném `IfMatchRequiredError` khi thiếu/rỗng/`*`/không parse được
  - `CaseNotFoundError` (404, `case_not_found`), `IfMatchRequiredError` (428, `if_match_required`), `VersionConflictError` (409, `version_conflict`, mang `diff: ThreeWayDiffDto`), `CaseStateError` (409, `invalid_case_state`), `FourEyesViolationError` (403, `four_eyes_self_promote`)

> **`If-Match: *` bị TỪ CHỐI (428), không phải chấp nhận.** RFC 9110 định nghĩa `*` là "khớp bất kỳ bản nào đang tồn tại" — tức là *tắt* kiểm tra đồng thời. Blueprint §4 đòi mọi mutation phải mang bản gốc mình sửa; cho `*` đi qua là mở lại đúng lớp lỗi mà cột `version` sinh ra để đóng. Client muốn ghi đè có chủ đích thì GET lại rồi gửi version thật.
>
> **Vì sao 403 cho four-eyes mà không 404:** luật "cross-tenant ⇒ 404, không bao giờ 403" (§3 L3) là để **không rò rỉ sự tồn tại của id tenant khác**. Four-eyes xảy ra trong CÙNG tenant, với một actor đã được uỷ quyền và đã nhìn thấy case — không có gì để rò rỉ, và 404 ở đây sẽ nói dối người dùng rằng case biến mất.

- [ ] **Step 1: Viết test ĐỎ `apps/core/src/modules/authoring/concurrency.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { formatETag, parseIfMatch } from "./concurrency.js";
import { IfMatchRequiredError, VersionConflictError } from "./errors.js";

describe("formatETag", () => {
  it("bọc version trong dấu nháy kép — entity-tag của RFC 9110", () => {
    expect(formatETag(1)).toBe('"1"');
    expect(formatETag(42)).toBe('"42"');
  });
});

describe("parseIfMatch", () => {
  it("đọc được entity-tag có nháy", () => {
    expect(parseIfMatch('"7"')).toBe(7);
  });

  it("chấp nhận dạng trần (client viết tay hay quên nháy)", () => {
    expect(parseIfMatch("7")).toBe(7);
  });

  it("chấp nhận weak tag W/\"7\"", () => {
    expect(parseIfMatch('W/"7"')).toBe(7);
  });

  it("THIẾU header ⇒ IfMatchRequiredError (HTTP 428)", () => {
    expect(() => parseIfMatch(undefined)).toThrow(IfMatchRequiredError);
    try {
      parseIfMatch(undefined);
    } catch (e) {
      expect((e as IfMatchRequiredError).httpStatus).toBe(428);
      expect((e as IfMatchRequiredError).code).toBe("if_match_required");
    }
  });

  it("header rỗng hoặc toàn khoảng trắng ⇒ 428", () => {
    expect(() => parseIfMatch("")).toThrow(IfMatchRequiredError);
    expect(() => parseIfMatch("   ")).toThrow(IfMatchRequiredError);
  });

  it("`*` bị TỪ CHỐI — nó nghĩa là tắt kiểm tra đồng thời", () => {
    expect(() => parseIfMatch("*")).toThrow(IfMatchRequiredError);
  });

  it("giá trị không phải số nguyên dương ⇒ 428", () => {
    for (const bad of ['"abc"', '"0"', '"-1"', '"1.5"', '"1,2"']) {
      expect(() => parseIfMatch(bad)).toThrow(IfMatchRequiredError);
    }
  });
});

describe("VersionConflictError", () => {
  it("mang nguyên diff 3 chiều để route trả thẳng vào body 409", () => {
    const diff = {
      baseVersion: 7, baseRevisionId: "r7", currentVersion: 9, currentRevisionId: "r9",
      mine: [], theirs: [], conflicts: [],
    };
    const err = new VersionConflictError(diff);
    expect(err.httpStatus).toBe(409);
    expect(err.code).toBe("version_conflict");
    expect(err.diff).toBe(diff);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm --filter @testkite/core test src/modules/authoring/concurrency.test.ts`
Expected: FAIL — không resolve `./concurrency.js`.

- [ ] **Step 3: Implement `apps/core/src/modules/authoring/errors.ts`**

```ts
/**
 * Taxonomy lỗi của authoring. Mỗi lỗi tự mang `httpStatus` + `code` để route
 * chỉ còn việc ánh xạ, không phải đoán.
 */
import type { ThreeWayDiffDto } from "@testkite/contract";

/**
 * 404 cho MỌI trường hợp "không thấy", kể cả khi id có thật nhưng thuộc tenant
 * khác (blueprint §3 L3: cross-tenant KHÔNG BAO GIỜ 403 — 403 xác nhận id tồn tại).
 */
export class CaseNotFoundError extends Error {
  readonly httpStatus = 404;
  readonly code = "case_not_found";
  constructor(caseId: string) {
    super(`Không tìm thấy case ${caseId}`);
    this.name = "CaseNotFoundError";
  }
}

/** 428 Precondition Required — mutation không mang If-Match hợp lệ. */
export class IfMatchRequiredError extends Error {
  readonly httpStatus = 428;
  readonly code = "if_match_required";
  constructor(reason: string) {
    super(`Cần header If-Match với version của case: ${reason}`);
    this.name = "IfMatchRequiredError";
  }
}

/** 409 — version client gửi khác version trên server. Mang theo diff 3 chiều. */
export class VersionConflictError extends Error {
  readonly httpStatus = 409;
  readonly code = "version_conflict";
  readonly diff: ThreeWayDiffDto;
  constructor(diff: ThreeWayDiffDto) {
    super(`Case đã đổi: bạn dựa trên version ${diff.baseVersion}, server đang ở ${diff.currentVersion}`);
    this.name = "VersionConflictError";
    this.diff = diff;
  }
}

/** 409 — thao tác không hợp lệ với trạng thái hiện tại (submit case đã ready...). */
export class CaseStateError extends Error {
  readonly httpStatus = 409;
  readonly code = "invalid_case_state";
  constructor(message: string) {
    super(message);
    this.name = "CaseStateError";
  }
}

/**
 * 403 — four-eyes: người sửa cuối tự promote. KHÁC 404 cross-tenant có chủ đích:
 * đây là vi phạm chính sách TRONG cùng tenant, actor đã thấy case rồi, không có
 * gì để rò rỉ; trả 404 ở đây là nói dối rằng case biến mất.
 */
export class FourEyesViolationError extends Error {
  readonly httpStatus = 403;
  readonly code = "four_eyes_self_promote";
  constructor(caseId: string) {
    super(
      `Bạn là người sửa cuối case ${caseId} nên không thể tự promote. ` +
        `Cần người thứ hai, hoặc team bật teams.allow_self_promote.`,
    );
    this.name = "FourEyesViolationError";
  }
}
```

- [ ] **Step 4: Implement `apps/core/src/modules/authoring/concurrency.ts`**

```ts
/**
 * ETag/If-Match cho case (blueprint §4: version + ETag/If-Match, 428 nếu thiếu).
 * ETag = version dạng entity-tag RFC 9110. Thuần — không I/O.
 */
import { IfMatchRequiredError } from "./errors.js";

export function formatETag(version: number): string {
  return `"${String(version)}"`;
}

const ETAG_RE = /^(?:W\/)?"?(\d+)"?$/;

/**
 * Trả về version client đang dựa trên. Ném IfMatchRequiredError (428) cho MỌI
 * đầu vào không phải một version cụ thể — kể cả `*`: `*` nghĩa là "khớp bản nào
 * cũng được", tức tắt kiểm tra đồng thời, đúng thứ cột version sinh ra để chặn.
 */
export function parseIfMatch(header: string | undefined): number {
  if (header === undefined) throw new IfMatchRequiredError("header vắng mặt");
  const raw = header.trim();
  if (raw.length === 0) throw new IfMatchRequiredError("header rỗng");
  if (raw === "*") {
    throw new IfMatchRequiredError("`*` không được chấp nhận — gửi version cụ thể của bản bạn đang sửa");
  }
  const m = ETAG_RE.exec(raw);
  const captured = m?.[1];
  if (captured === undefined) throw new IfMatchRequiredError(`không đọc được entity-tag: ${raw}`);
  const version = Number(captured);
  if (!Number.isInteger(version) || version <= 0) {
    throw new IfMatchRequiredError(`version phải là số nguyên dương, nhận: ${raw}`);
  }
  return version;
}
```

- [ ] **Step 5: Chạy test, xác nhận XANH**

Run: `cd testkite && pnpm --filter @testkite/core test src/modules/authoring/concurrency.test.ts`
Expected: PASS 9 test.

- [ ] **Step 6: Commit**

```bash
git add testkite/apps/core/src/modules/authoring/concurrency.ts \
        testkite/apps/core/src/modules/authoring/errors.ts \
        testkite/apps/core/src/modules/authoring/concurrency.test.ts
git commit -m "M2-AUT T7: ETag/If-Match (428) + taxonomy loi authoring"
```

---

## Task 8 — Phẳng hoá cây step: `StepInput[]` → row + `RevisionPayload` (thuần)

**Files:**
- Create: `apps/core/src/modules/authoring/steps-flatten.ts`
- Create: `apps/core/src/modules/authoring/steps-flatten.test.ts`

**Interfaces:**
- Consumes: `StepInputDto` (Task 5), `RevisionPayload`/`RevisionStep` (Task 6).
- Produces:
  - `type StepRow = { readonly id: string; readonly caseId: string; readonly parentStepId: string | null; readonly ordinal: number; readonly kind: StepKindDto; readonly renderedSentence: string; readonly verbOpKey: string | null; readonly elementId: string | null; readonly args: Record<string,string> | null; readonly stepGroupCaseId: string | null; readonly conditionExpected: string[] | null }`
  - `type LoopRow = { readonly stepId: string; readonly dataProfileId: string | null; readonly maxIterations: number | null }`
  - `type RestRow = { readonly stepId: string; readonly method: string; readonly url: string; readonly headers: Record<string,string> | null; readonly body: string | null; readonly storeAs: string | null }`
  - `flattenStepInputs(input: { readonly caseId: string; readonly steps: readonly StepInputDto[]; readonly existingIds: ReadonlySet<string>; readonly newId: () => string }): { readonly steps: StepRow[]; readonly loops: LoopRow[]; readonly rests: RestRow[] }`
  - `buildRevisionPayload(input: { readonly case: RevisionCase; readonly steps: readonly StepRow[]; readonly loops: readonly LoopRow[]; readonly rests: readonly RestRow[] }): RevisionPayload`

> **Luật giữ danh tính step:** `id` client gửi lên chỉ được **tái sử dụng khi nó đã thuộc case này** (`existingIds`). Id lạ ⇒ cấp id mới, im lặng. Nếu không có luật đó, client gửi id của step thuộc case khác (hoặc tenant khác) sẽ ghi đè danh tính — vừa là lỗ tenant, vừa làm diff nói dối.
>
> `newId` được **tiêm vào** chứ không gọi `crypto.randomUUID()` bên trong: hàm này phải thuần để test so kết quả từng byte.

- [ ] **Step 1: Viết test ĐỎ `apps/core/src/modules/authoring/steps-flatten.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import type { StepInputDto } from "@testkite/contract";
import { buildRevisionPayload, flattenStepInputs } from "./steps-flatten.js";

/** id sinh tuần tự để test so được từng byte. */
function seqIds(): () => string {
  let n = 0;
  return () => `new-${++n}`;
}

const TREE: StepInputDto[] = [
  { id: "s1", kind: "action", renderedSentence: "open login", verbOpKey: "goto" },
  {
    kind: "if",
    renderedSentence: "if ok",
    conditionExpected: ["SUCCESS"],
    children: [
      { id: "s2", kind: "action", renderedSentence: "type username", verbOpKey: "type", args: { value: "qa" } },
      {
        kind: "for",
        renderedSentence: "for each row",
        loopDataProfileId: "d1",
        children: [{ kind: "rest", renderedSentence: "POST orders", method: "POST", url: "https://x.test/o" }],
      },
    ],
  },
];

describe("flattenStepInputs", () => {
  it("làm phẳng cây theo thứ tự duyệt trước, ordinal đếm lại trong từng nhóm anh em", () => {
    const r = flattenStepInputs({
      caseId: "c1",
      steps: TREE,
      existingIds: new Set(["s1", "s2"]),
      newId: seqIds(),
    });
    expect(r.steps.map((s) => [s.id, s.parentStepId, s.ordinal, s.kind])).toEqual([
      ["s1", null, 1, "action"],
      ["new-1", null, 2, "if"],
      ["s2", "new-1", 1, "action"],
      ["new-2", "new-1", 2, "for"],
      ["new-3", "new-2", 1, "rest"],
    ]);
  });

  it("GIỮ id client gửi khi id đó đã thuộc case; cấp id mới khi id lạ", () => {
    const r = flattenStepInputs({
      caseId: "c1",
      steps: [{ id: "khong-thuoc-case-nay", kind: "action", renderedSentence: "x", verbOpKey: "click" }],
      existingIds: new Set(["s1"]),
      newId: seqIds(),
    });
    expect(r.steps[0]?.id).toBe("new-1");
  });

  it("tách chi tiết vòng lặp sang LoopRow, chi tiết REST sang RestRow", () => {
    const r = flattenStepInputs({ caseId: "c1", steps: TREE, existingIds: new Set(["s1", "s2"]), newId: seqIds() });
    expect(r.loops).toEqual([{ stepId: "new-2", dataProfileId: "d1", maxIterations: null }]);
    expect(r.rests).toEqual([
      { stepId: "new-3", method: "POST", url: "https://x.test/o", headers: null, body: null, storeAs: null },
    ]);
  });

  it("cột của kind khác luôn NULL — khớp CHECK aut_steps_kind_shape", () => {
    const r = flattenStepInputs({ caseId: "c1", steps: TREE, existingIds: new Set(), newId: seqIds() });
    const ifRow = r.steps.find((s) => s.kind === "if");
    expect(ifRow?.verbOpKey).toBeNull();
    expect(ifRow?.stepGroupCaseId).toBeNull();
    expect(ifRow?.conditionExpected).toEqual(["SUCCESS"]);
    const forRow = r.steps.find((s) => s.kind === "for");
    expect(forRow?.verbOpKey).toBeNull();
    expect(forRow?.conditionExpected).toBeNull();
  });

  it("while không maxIterations vẫn phẳng hoá được — compiler mới là nơi phán", () => {
    const r = flattenStepInputs({
      caseId: "c1",
      steps: [{ kind: "while", renderedSentence: "while spinner", children: [] }],
      existingIds: new Set(),
      newId: seqIds(),
    });
    expect(r.loops).toEqual([{ stepId: "new-1", dataProfileId: null, maxIterations: null }]);
  });
});

describe("buildRevisionPayload", () => {
  it("mã hoá vị trí bằng `after` (id anh liền trước), KHÔNG có ordinal", () => {
    const flat = flattenStepInputs({ caseId: "c1", steps: TREE, existingIds: new Set(["s1", "s2"]), newId: seqIds() });
    const payload = buildRevisionPayload({
      case: { name: "C", isStepGroup: false },
      steps: flat.steps,
      loops: flat.loops,
      rests: flat.rests,
    });
    expect(payload.steps.map((s) => [s.id, s.parentId, s.after])).toEqual([
      ["s1", null, null],
      ["new-1", null, "s1"],
      ["s2", "new-1", null],
      ["new-2", "new-1", "s2"],
      ["new-3", "new-2", null],
    ]);
    expect(JSON.stringify(payload)).not.toContain("ordinal");
  });

  it("gắn loop/rest vào đúng step", () => {
    const flat = flattenStepInputs({ caseId: "c1", steps: TREE, existingIds: new Set(), newId: seqIds() });
    const payload = buildRevisionPayload({
      case: { name: "C", isStepGroup: false },
      steps: flat.steps,
      loops: flat.loops,
      rests: flat.rests,
    });
    const forStep = payload.steps.find((s) => s.kind === "for");
    expect(forStep?.loop).toEqual({ dataProfileId: "d1" });
    const restStep = payload.steps.find((s) => s.kind === "rest");
    expect(restStep?.rest).toEqual({ method: "POST", url: "https://x.test/o" });
  });

  it("bỏ hẳn field undefined — hash canonical không được phụ thuộc cách dựng object", () => {
    const flat = flattenStepInputs({
      caseId: "c1",
      steps: [{ kind: "action", renderedSentence: "click", verbOpKey: "click" }],
      existingIds: new Set(),
      newId: seqIds(),
    });
    const payload = buildRevisionPayload({
      case: { name: "C", isStepGroup: false },
      steps: flat.steps,
      loops: flat.loops,
      rests: flat.rests,
    });
    expect(Object.keys(payload.steps[0] ?? {}).sort()).toEqual([
      "after", "id", "kind", "parentId", "renderedSentence", "verbOpKey",
    ]);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm --filter @testkite/core test src/modules/authoring/steps-flatten.test.ts`
Expected: FAIL — không resolve `./steps-flatten.js`.

- [ ] **Step 3: Implement `apps/core/src/modules/authoring/steps-flatten.ts`**

```ts
/**
 * Cầu nối giữa hình dạng API (cây step lồng nhau, không ordinal) và hình dạng DB
 * (bảng phẳng có parent_step_id + ordinal) — và giữa DB với payload revision
 * (phẳng, vị trí bằng `after`). THUẦN: mọi thứ bất định (id mới) được tiêm vào.
 */
import type { StepInputDto, StepKindDto } from "@testkite/contract";
import type { RevisionCase, RevisionPayload, RevisionStep } from "./revision/payload.js";

export interface StepRow {
  readonly id: string;
  readonly caseId: string;
  readonly parentStepId: string | null;
  readonly ordinal: number;
  readonly kind: StepKindDto;
  readonly renderedSentence: string;
  readonly verbOpKey: string | null;
  readonly elementId: string | null;
  readonly args: Record<string, string> | null;
  readonly stepGroupCaseId: string | null;
  readonly conditionExpected: string[] | null;
}

export interface LoopRow {
  readonly stepId: string;
  readonly dataProfileId: string | null;
  readonly maxIterations: number | null;
}

export interface RestRow {
  readonly stepId: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string> | null;
  readonly body: string | null;
  readonly storeAs: string | null;
}

export interface FlattenInput {
  readonly caseId: string;
  readonly steps: readonly StepInputDto[];
  /** id step ĐANG thuộc case này — chỉ những id trong tập này mới được tái dùng. */
  readonly existingIds: ReadonlySet<string>;
  readonly newId: () => string;
}

export interface FlattenResult {
  readonly steps: StepRow[];
  readonly loops: LoopRow[];
  readonly rests: RestRow[];
}

export function flattenStepInputs(input: FlattenInput): FlattenResult {
  const steps: StepRow[] = [];
  const loops: LoopRow[] = [];
  const rests: RestRow[] = [];
  const used = new Set<string>();

  const resolveId = (candidate: string | undefined): string => {
    // Id lạ (của case khác / tenant khác / bịa) KHÔNG được tái dùng: nó vừa là lỗ
    // tenant vừa làm diff nói dối về danh tính step.
    if (candidate !== undefined && input.existingIds.has(candidate) && !used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    return input.newId();
  };

  const walk = (nodes: readonly StepInputDto[], parentStepId: string | null): void => {
    let ordinal = 0;
    for (const node of nodes) {
      ordinal += 1;
      const id = resolveId(node.id);
      const base = {
        id,
        caseId: input.caseId,
        parentStepId,
        ordinal,
        kind: node.kind,
        renderedSentence: node.renderedSentence,
        verbOpKey: null,
        elementId: null,
        args: null,
        stepGroupCaseId: null,
        conditionExpected: null,
      } satisfies StepRow;

      switch (node.kind) {
        case "action":
          steps.push({
            ...base,
            verbOpKey: node.verbOpKey,
            elementId: node.elementId ?? null,
            args: node.args ?? null,
          });
          break;
        case "step_group":
          steps.push({ ...base, stepGroupCaseId: node.stepGroupCaseId });
          break;
        case "if":
          steps.push({ ...base, conditionExpected: [...node.conditionExpected] });
          walk(node.children, id);
          break;
        case "for":
          steps.push(base);
          loops.push({ stepId: id, dataProfileId: node.loopDataProfileId, maxIterations: null });
          walk(node.children, id);
          break;
        case "while":
          steps.push(base);
          loops.push({ stepId: id, dataProfileId: null, maxIterations: node.maxIterations ?? null });
          walk(node.children, id);
          break;
        case "rest":
          steps.push(base);
          rests.push({
            stepId: id,
            method: node.method,
            url: node.url,
            headers: node.headers ?? null,
            body: node.body ?? null,
            storeAs: node.storeAs ?? null,
          });
          break;
      }
    }
  };

  walk(input.steps, null);
  return { steps, loops, rests };
}

export interface BuildPayloadInput {
  readonly case: RevisionCase;
  readonly steps: readonly StepRow[];
  readonly loops: readonly LoopRow[];
  readonly rests: readonly RestRow[];
}

/**
 * Dựng payload revision. Hai luật:
 *   1. Vị trí = `after` (id anh liền trước cùng cha), KHÔNG phải ordinal — xem
 *      diff.ts để biết vì sao (spike đo nhiễu 2026-08-28).
 *   2. Field không có giá trị thì BỎ HẲN khỏi object, không set null: hash canonical
 *      phải chỉ phụ thuộc dữ liệu, không phụ thuộc cách dựng object.
 */
export function buildRevisionPayload(input: BuildPayloadInput): RevisionPayload {
  const loopByStep = new Map(input.loops.map((l) => [l.stepId, l]));
  const restByStep = new Map(input.rests.map((r) => [r.stepId, r]));
  const lastSiblingOf = new Map<string | null, string | null>();

  const steps: RevisionStep[] = [];
  // input.steps đã theo thứ tự duyệt trước, và trong mỗi nhóm anh em thì ordinal tăng
  // dần — nên "anh liền trước" chính là step gần nhất có cùng parent.
  for (const row of [...input.steps].sort((a, b) => a.ordinal - b.ordinal || 0)) {
    void row;
  }
  for (const row of input.steps) {
    const after = lastSiblingOf.get(row.parentStepId) ?? null;
    lastSiblingOf.set(row.parentStepId, row.id);
    const loop = loopByStep.get(row.id);
    const rest = restByStep.get(row.id);
    steps.push({
      id: row.id,
      kind: row.kind,
      parentId: row.parentStepId,
      after,
      renderedSentence: row.renderedSentence,
      ...(row.verbOpKey === null ? {} : { verbOpKey: row.verbOpKey }),
      ...(row.elementId === null ? {} : { elementId: row.elementId }),
      ...(row.args === null ? {} : { args: row.args }),
      ...(row.stepGroupCaseId === null ? {} : { stepGroupCaseId: row.stepGroupCaseId }),
      ...(row.conditionExpected === null ? {} : { conditionExpected: row.conditionExpected }),
      ...(loop === undefined
        ? {}
        : {
            loop: {
              ...(loop.dataProfileId === null ? {} : { dataProfileId: loop.dataProfileId }),
              ...(loop.maxIterations === null ? {} : { maxIterations: loop.maxIterations }),
            },
          }),
      ...(rest === undefined
        ? {}
        : {
            rest: {
              method: rest.method,
              url: rest.url,
              ...(rest.headers === null ? {} : { headers: rest.headers }),
              ...(rest.body === null ? {} : { body: rest.body }),
              ...(rest.storeAs === null ? {} : { storeAs: rest.storeAs }),
            },
          }),
    });
  }
  return { case: input.case, steps };
}
```

> Vòng `for (const row of [...input.steps].sort(...)) { void row; }` ở trên là **thừa** — xoá nó khi implement. Nó bị để lại làm bẫy: `input.steps` đã đúng thứ tự duyệt trước từ `flattenStepInputs`, sắp lại theo `ordinal` toàn cục sẽ làm hỏng `after` của step con. Nếu bạn đang đọc và định "dọn dẹp" bằng cách sắp xếp — đừng.

- [ ] **Step 4: Chạy test, xác nhận XANH**

Run: `cd testkite && pnpm --filter @testkite/core test src/modules/authoring/steps-flatten.test.ts`
Expected: PASS 8 test.

- [ ] **Step 5: Verify + commit**

Run: `cd testkite && pnpm typecheck && pnpm --filter @testkite/core test`

```bash
git add testkite/apps/core/src/modules/authoring/steps-flatten.ts \
        testkite/apps/core/src/modules/authoring/steps-flatten.test.ts
git commit -m "M2-AUT T8: phang hoa cay step -> row + RevisionPayload"
```

---

## Task 9 — Repo + service: tạo case, sửa steps, ghi revision, 428/409

**Files:**
- Create: `apps/core/src/modules/authoring/db/case-repo.ts`
- Create: `apps/core/src/modules/authoring/db/revision-repo.ts`
- Create: `apps/core/src/modules/authoring/case-service.ts`
- Create: `apps/core/test/authoring/case-service.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `TenantRepo`, `TenantContext`, `TkTx` (facade kernel); `flattenStepInputs`, `buildRevisionPayload` (Task 8); `encodeRevision`, `decodeRevision` (Task 1); `threeWayDiff` (Task 6); lỗi (Task 7).
- Produces:
  - `type Actor = { readonly userId: string }`
  - `class CaseRepo extends TenantRepo` — `insertCase`, `findById`, `listStepRows`, `deleteSteps`, `insertSteps`, `applyEdit`
  - `class RevisionRepo extends TenantRepo` — `insert`, `findByCaseVersion`, `findById`, `loadPayload`
  - `createCase(tx, ctx, actor, input): Promise<CaseSummaryDto>`
  - `replaceSteps(tx, ctx, actor, input): Promise<CaseSummaryDto>` với `input = { caseId: string; expectedVersion: number; steps: readonly StepInputDto[] }`
  - `toCaseSummary(row): CaseSummaryDto`

> **Ba luật nghiệp vụ chốt ở task này:**
> 1. **Mỗi mutation ghi đúng một revision** và bump `version` lên 1. Bất biến: `revision_no = case_version` tại thời điểm ghi (giữ hai cột vì `revision_no` là thứ UI đọc, `case_version` là mỏ neo của If-Match; không cưỡng chế bằng CHECK để chừa đường cho revision nhập khẩu ở M7).
> 2. **Sửa được khi `draft` hoặc `ready`; KHÔNG sửa được khi `in_review`.** Sửa một case `ready` đưa nó về `draft` nhưng **giữ nguyên `ready_revision_id`** — đúng ngữ nghĩa ghim của blueprint §4 phase 1: lịch đêm vẫn compile bản `ready` cũ trong lúc tác giả sửa bản nháp. Muốn sửa case đang review thì rút review trước (Task 10).
> 3. **Id step lạ không bao giờ được tái dùng** — `existingIds` lấy từ chính case đó (Task 8).

- [ ] **Step 1: Viết test ĐỎ `apps/core/test/authoring/case-service.test.ts`**

```ts
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import type { StepInputDto } from "@testkite/contract";
import { withTenant } from "../../src/modules/kernel/index.js";
import { createCase, replaceSteps } from "../../src/modules/authoring/case-service.js";
import { RevisionRepo } from "../../src/modules/authoring/db/revision-repo.js";
import { CaseStateError, VersionConflictError } from "../../src/modules/authoring/errors.js";
import { makeTestDb, type TestDb } from "../harness/pglite.js";

let t: TestDb;
let teamId = "";
let projectId = "";
const alice = { userId: "" };
const bob = { userId: "" };

beforeAll(async () => {
  t = await makeTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  const org = await t.db.execute(sql`INSERT INTO organizations (name, slug) VALUES ('Acme','acme') RETURNING id`);
  const orgId = String(org.rows[0]?.["id"]);
  const team = await t.db.execute(sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},'A','a') RETURNING id`);
  teamId = String(team.rows[0]?.["id"]);
  const p = await t.db.execute(sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamId},'P','p') RETURNING id`);
  projectId = String(p.rows[0]?.["id"]);
  const u1 = await t.db.execute(sql`INSERT INTO users (email, display_name) VALUES ('a@x.test','Alice') RETURNING id`);
  const u2 = await t.db.execute(sql`INSERT INTO users (email, display_name) VALUES ('b@x.test','Bob') RETURNING id`);
  alice.userId = String(u1.rows[0]?.["id"]);
  bob.userId = String(u2.rows[0]?.["id"]);
});

const ctx = (): { teamId: string } => ({ teamId });

const TWO_STEPS: StepInputDto[] = [
  { kind: "action", renderedSentence: "open login page", verbOpKey: "goto" },
  { kind: "action", renderedSentence: "type username", verbOpKey: "type", args: { value: "qa" } },
];

describe("createCase", () => {
  it("tạo case draft version 1 và ghi revision #1 ngay lập tức", async () => {
    const summary = await withTenant(t.db, ctx(), (tx) =>
      createCase(tx, ctx(), alice, { projectId, name: "Checkout", isStepGroup: false }),
    );
    expect(summary.status).toBe("draft");
    expect(summary.version).toBe(1);
    expect(summary.latestRevisionId).toBeDefined();
    expect(summary.readyRevisionId).toBeUndefined();
    expect(summary.lastEditedBy).toBe(alice.userId);

    const r = await t.db.execute(sql`
      SELECT revision_no, case_version, codec FROM aut_case_revisions WHERE case_id = ${summary.id}`);
    expect(r.rows.length).toBe(1);
    expect(Number(r.rows[0]?.["revision_no"])).toBe(1);
    expect(Number(r.rows[0]?.["case_version"])).toBe(1);
  });
});

describe("replaceSteps", () => {
  async function seedCase(): Promise<{ id: string; version: number }> {
    const s = await withTenant(t.db, ctx(), (tx) =>
      createCase(tx, ctx(), alice, { projectId, name: "Checkout", isStepGroup: false }),
    );
    return { id: s.id, version: s.version };
  }

  it("ghi steps, bump version, ghi revision mới, cập nhật last_edited_by", async () => {
    const c = await seedCase();
    const after = await withTenant(t.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), bob, { caseId: c.id, expectedVersion: c.version, steps: TWO_STEPS }),
    );
    expect(after.version).toBe(2);
    expect(after.lastEditedBy).toBe(bob.userId);

    const steps = await t.db.execute(sql`
      SELECT ordinal, kind, rendered_sentence FROM aut_steps WHERE case_id = ${c.id} ORDER BY ordinal`);
    expect(steps.rows.map((x) => x["rendered_sentence"])).toEqual(["open login page", "type username"]);

    const revs = await t.db.execute(sql`
      SELECT revision_no, case_version FROM aut_case_revisions WHERE case_id = ${c.id} ORDER BY revision_no`);
    expect(revs.rows.map((x) => Number(x["case_version"]))).toEqual([1, 2]);
  });

  it("payload revision giải nén ra đúng cây step vừa ghi", async () => {
    const c = await seedCase();
    const after = await withTenant(t.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), alice, { caseId: c.id, expectedVersion: c.version, steps: TWO_STEPS }),
    );
    const payload = await withTenant(t.db, ctx(), async (tx) => {
      const repo = new RevisionRepo(tx, ctx());
      return repo.loadPayload(after.latestRevisionId ?? "");
    });
    expect(payload.steps.map((s) => s.renderedSentence)).toEqual(["open login page", "type username"]);
    expect(payload.steps[0]?.after).toBeNull();
    expect(payload.steps[1]?.after).toBe(payload.steps[0]?.id);
  });

  it("giữ nguyên id của step client echo về — danh tính step sống qua nhiều lần lưu", async () => {
    const c = await seedCase();
    const v2 = await withTenant(t.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), alice, { caseId: c.id, expectedVersion: c.version, steps: TWO_STEPS }),
    );
    const ids = await t.db.execute(sql`SELECT id FROM aut_steps WHERE case_id = ${c.id} ORDER BY ordinal`);
    const firstId = String(ids.rows[0]?.["id"]);
    await withTenant(t.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), alice, {
        caseId: c.id,
        expectedVersion: v2.version,
        steps: [
          { id: firstId, kind: "action", renderedSentence: "open login page (v2)", verbOpKey: "goto" },
          ...TWO_STEPS.slice(1),
        ],
      }),
    );
    const after = await t.db.execute(sql`SELECT id FROM aut_steps WHERE case_id = ${c.id} ORDER BY ordinal`);
    expect(String(after.rows[0]?.["id"])).toBe(firstId);
  });

  it("version lệch ⇒ VersionConflictError mang diff 3 chiều đúng", async () => {
    const c = await seedCase();
    // Alice lưu trước, đẩy server lên version 2.
    await withTenant(t.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), alice, { caseId: c.id, expectedVersion: 1, steps: TWO_STEPS }),
    );
    // Bob vẫn cầm version 1 và lưu bản khác.
    const err = await withTenant(t.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), bob, {
        caseId: c.id,
        expectedVersion: 1,
        steps: [{ kind: "action", renderedSentence: "accept cookie banner", verbOpKey: "click" }],
      }),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(VersionConflictError);
    const conflict = err as VersionConflictError;
    expect(conflict.httpStatus).toBe(409);
    expect(conflict.diff.baseVersion).toBe(1);
    expect(conflict.diff.currentVersion).toBe(2);
    expect(conflict.diff.mine.length).toBeGreaterThan(0);
    expect(conflict.diff.theirs.length).toBeGreaterThan(0);
  });

  it("KHÔNG ghi gì khi conflict — số revision không tăng", async () => {
    const c = await seedCase();
    await withTenant(t.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), alice, { caseId: c.id, expectedVersion: 1, steps: TWO_STEPS }),
    );
    const before = await t.db.execute(sql`SELECT count(*)::int AS n FROM aut_case_revisions WHERE case_id = ${c.id}`);
    await withTenant(t.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), bob, { caseId: c.id, expectedVersion: 1, steps: TWO_STEPS }),
    ).catch(() => undefined);
    const after = await t.db.execute(sql`SELECT count(*)::int AS n FROM aut_case_revisions WHERE case_id = ${c.id}`);
    expect(after.rows[0]?.["n"]).toBe(before.rows[0]?.["n"]);
  });

  it("case của tenant khác ⇒ CaseNotFoundError (404), KHÔNG phải 403", async () => {
    const c = await seedCase();
    const org = await t.db.execute(sql`SELECT id FROM organizations LIMIT 1`);
    const other = await t.db.execute(
      sql`INSERT INTO teams (org_id,name,slug) VALUES (${String(org.rows[0]?.["id"])},'B','b') RETURNING id`,
    );
    const otherTeamId = String(other.rows[0]?.["id"]);
    const err = await withTenant(t.db, { teamId: otherTeamId }, (tx) =>
      replaceSteps(tx, { teamId: otherTeamId }, alice, { caseId: c.id, expectedVersion: 1, steps: TWO_STEPS }),
    ).catch((e: unknown) => e);
    expect((err as { httpStatus?: number }).httpStatus).toBe(404);
  });

  it("sửa case đang in_review ⇒ CaseStateError", async () => {
    const c = await seedCase();
    await t.db.execute(sql`
      UPDATE aut_cases SET status='in_review', submitted_at=now(), submitted_by=${alice.userId}
      WHERE id = ${c.id}`);
    const err = await withTenant(t.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), alice, { caseId: c.id, expectedVersion: 1, steps: TWO_STEPS }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaseStateError);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm --filter @testkite/core test test/authoring/case-service.test.ts`
Expected: FAIL — không resolve `case-service.js`.

- [ ] **Step 3: Implement `apps/core/src/modules/authoring/db/case-repo.ts`**

```ts
import { and, asc, eq } from "drizzle-orm";
import { TenantRepo, type TenantContext, type TkTx } from "../../kernel/index.js";
import { autCases, autRestSteps, autStepLoops, autSteps } from "./schema.js";
import type { LoopRow, RestRow, StepRow } from "../steps-flatten.js";

export type CaseRow = typeof autCases.$inferSelect;

export interface InsertCaseInput {
  readonly projectId: string;
  readonly name: string;
  readonly isStepGroup: boolean;
  readonly prereqCaseId?: string | undefined;
  readonly dataProfileId?: string | undefined;
  readonly actorUserId: string;
}

/** L1: mọi truy vấn đều mang `teamId` của TenantContext, không tin RLS một mình. */
export class CaseRepo extends TenantRepo {
  constructor(tx: TkTx, ctx: TenantContext) {
    super(tx, ctx);
  }

  async insertCase(input: InsertCaseInput): Promise<CaseRow> {
    const rows = await this.tx
      .insert(autCases)
      .values({
        teamId: this.teamId,
        projectId: input.projectId,
        name: input.name,
        isStepGroup: input.isStepGroup,
        ...(input.prereqCaseId === undefined ? {} : { prereqCaseId: input.prereqCaseId }),
        lastEditedBy: input.actorUserId,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("aut_cases: INSERT không trả row");
    return row;
  }

  async findById(caseId: string): Promise<CaseRow | undefined> {
    const rows = await this.tx
      .select()
      .from(autCases)
      .where(and(eq(autCases.teamId, this.teamId), eq(autCases.id, caseId)))
      .limit(1);
    return rows[0];
  }

  async listStepRows(caseId: string): Promise<StepRow[]> {
    const rows = await this.tx
      .select()
      .from(autSteps)
      .where(and(eq(autSteps.teamId, this.teamId), eq(autSteps.caseId, caseId)))
      .orderBy(asc(autSteps.ordinal), asc(autSteps.id));
    return rows.map((r) => ({
      id: r.id,
      caseId: r.caseId,
      parentStepId: r.parentStepId,
      ordinal: r.ordinal,
      kind: r.kind,
      renderedSentence: r.renderedSentence,
      verbOpKey: r.verbOpKey,
      elementId: r.elementId,
      args: r.args as Record<string, string> | null,
      stepGroupCaseId: r.stepGroupCaseId,
      conditionExpected: r.conditionExpected,
    }));
  }

  /** Xoá theo case: FK ON DELETE CASCADE dọn luôn step con, loop và rest. */
  async deleteSteps(caseId: string): Promise<void> {
    await this.tx
      .delete(autSteps)
      .where(and(eq(autSteps.teamId, this.teamId), eq(autSteps.caseId, caseId)));
  }

  async insertSteps(steps: readonly StepRow[], loops: readonly LoopRow[], rests: readonly RestRow[]): Promise<void> {
    if (steps.length === 0) return;
    // Cha phải có trước con (self-FK) — flattenStepInputs đã trả theo thứ tự duyệt trước.
    for (const s of steps) {
      await this.tx.insert(autSteps).values({
        teamId: this.teamId,
        id: s.id,
        caseId: s.caseId,
        parentStepId: s.parentStepId,
        ordinal: s.ordinal,
        kind: s.kind,
        renderedSentence: s.renderedSentence,
        verbOpKey: s.verbOpKey,
        elementId: s.elementId,
        args: s.args,
        stepGroupCaseId: s.stepGroupCaseId,
        conditionExpected: s.conditionExpected,
      });
    }
    for (const l of loops) {
      await this.tx.insert(autStepLoops).values({
        teamId: this.teamId,
        stepId: l.stepId,
        dataProfileId: l.dataProfileId,
        maxIterations: l.maxIterations,
      });
    }
    for (const r of rests) {
      await this.tx.insert(autRestSteps).values({
        teamId: this.teamId,
        stepId: r.stepId,
        method: r.method,
        url: r.url,
        headers: r.headers,
        body: r.body,
        storeAs: r.storeAs,
      });
    }
  }

  /** Bump version + đóng dấu người sửa. Sửa case `ready` đưa nó về `draft`. */
  async applyEdit(caseId: string, nextVersion: number, actorUserId: string, revisionId: string): Promise<CaseRow> {
    const rows = await this.tx
      .update(autCases)
      .set({
        version: nextVersion,
        status: "draft",
        updatedAt: new Date(),
        lastEditedBy: actorUserId,
        latestRevisionId: revisionId,
      })
      .where(and(eq(autCases.teamId, this.teamId), eq(autCases.id, caseId)))
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("aut_cases: UPDATE không trả row");
    return row;
  }

  async setLatestRevision(caseId: string, revisionId: string): Promise<CaseRow> {
    const rows = await this.tx
      .update(autCases)
      .set({ latestRevisionId: revisionId })
      .where(and(eq(autCases.teamId, this.teamId), eq(autCases.id, caseId)))
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("aut_cases: UPDATE không trả row");
    return row;
  }
}
```

- [ ] **Step 4: Implement `apps/core/src/modules/authoring/db/revision-repo.ts`**

```ts
import { and, eq } from "drizzle-orm";
import { TenantRepo, type TenantContext, type TkTx } from "../../kernel/index.js";
import { decodeRevision, encodeRevision, type RevisionCodec } from "../revision/codec.js";
import type { RevisionPayload } from "../revision/payload.js";
import { autCaseRevisions } from "./schema.js";

export interface InsertRevisionInput {
  readonly caseId: string;
  /** Bất biến: bằng `caseVersion` tại thời điểm ghi. */
  readonly revisionNo: number;
  readonly caseVersion: number;
  readonly payload: RevisionPayload;
  readonly actorUserId: string;
  readonly note?: string | undefined;
}

/**
 * APPEND-ONLY: lớp này CỐ TÌNH không có update/delete. Không phải kỷ luật — role
 * `testkite_app` không có grant UPDATE/DELETE trên bảng này, nên thêm phương thức
 * đó vào cũng chỉ nhận `permission denied` lúc chạy.
 */
export class RevisionRepo extends TenantRepo {
  constructor(tx: TkTx, ctx: TenantContext) {
    super(tx, ctx);
  }

  async insert(input: InsertRevisionInput): Promise<string> {
    const enc = encodeRevision(input.payload);
    const rows = await this.tx
      .insert(autCaseRevisions)
      .values({
        teamId: this.teamId,
        caseId: input.caseId,
        revisionNo: input.revisionNo,
        caseVersion: input.caseVersion,
        codec: enc.codec,
        payload: enc.bytes,
        payloadSize: enc.rawSize,
        payloadSha256: enc.sha256,
        createdBy: input.actorUserId,
        ...(input.note === undefined ? {} : { note: input.note }),
      })
      .returning({ id: autCaseRevisions.id });
    const row = rows[0];
    if (row === undefined) throw new Error("aut_case_revisions: INSERT không trả id");
    return row.id;
  }

  async findByCaseVersion(caseId: string, caseVersion: number): Promise<{ id: string; payload: RevisionPayload } | undefined> {
    const rows = await this.tx
      .select()
      .from(autCaseRevisions)
      .where(
        and(
          eq(autCaseRevisions.teamId, this.teamId),
          eq(autCaseRevisions.caseId, caseId),
          eq(autCaseRevisions.caseVersion, caseVersion),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) return undefined;
    return { id: row.id, payload: decodeRevision(row.codec as RevisionCodec, row.payload) as RevisionPayload };
  }

  async loadPayload(revisionId: string): Promise<RevisionPayload> {
    const rows = await this.tx
      .select()
      .from(autCaseRevisions)
      .where(and(eq(autCaseRevisions.teamId, this.teamId), eq(autCaseRevisions.id, revisionId)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) throw new Error(`aut_case_revisions: không thấy revision ${revisionId}`);
    return decodeRevision(row.codec as RevisionCodec, row.payload) as RevisionPayload;
  }
}
```

- [ ] **Step 5: Implement `apps/core/src/modules/authoring/case-service.ts`**

```ts
/**
 * Vòng đời phần "sửa" của case. Mọi hàm ở đây NHẬN TkTx: chúng phải chạy trong
 * transaction do `withTenant` mở (role app + app.team_id đã set), nên không thể
 * tồn tại một đường ghi authoring nào không mang tenant.
 */
import { randomUUID } from "node:crypto";
import type { CaseSummaryDto, StepInputDto } from "@testkite/contract";
import type { TenantContext, TkTx } from "../kernel/index.js";
import { CaseRepo, type CaseRow } from "./db/case-repo.js";
import { RevisionRepo } from "./db/revision-repo.js";
import { CaseNotFoundError, CaseStateError, VersionConflictError } from "./errors.js";
import { threeWayDiff } from "./revision/diff.js";
import type { RevisionCase, RevisionPayload } from "./revision/payload.js";
import { buildRevisionPayload, flattenStepInputs } from "./steps-flatten.js";

export interface Actor {
  readonly userId: string;
}

export interface CreateCaseInput {
  readonly projectId: string;
  readonly name: string;
  readonly isStepGroup: boolean;
  readonly prereqCaseId?: string | undefined;
  readonly dataProfileId?: string | undefined;
}

export interface ReplaceStepsInput {
  readonly caseId: string;
  readonly expectedVersion: number;
  readonly steps: readonly StepInputDto[];
}

function iso(value: Date | null): string | undefined {
  return value === null ? undefined : value.toISOString();
}

export function toCaseSummary(row: CaseRow): CaseSummaryDto {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    isStepGroup: row.isStepGroup,
    status: row.status,
    version: row.version,
    ...(row.prereqCaseId === null ? {} : { prereqCaseId: row.prereqCaseId }),
    ...(row.latestRevisionId === null ? {} : { latestRevisionId: row.latestRevisionId }),
    ...(row.readyRevisionId === null ? {} : { readyRevisionId: row.readyRevisionId }),
    ...(row.lastEditedBy === null ? {} : { lastEditedBy: row.lastEditedBy }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(iso(row.submittedAt) === undefined ? {} : { submittedAt: row.submittedAt!.toISOString() }),
    ...(iso(row.reviewedAt) === undefined ? {} : { reviewedAt: row.reviewedAt!.toISOString() }),
    ...(iso(row.promotedAt) === undefined ? {} : { promotedAt: row.promotedAt!.toISOString() }),
  };
}

function caseOf(row: CaseRow): RevisionCase {
  return {
    name: row.name,
    isStepGroup: row.isStepGroup,
    ...(row.prereqCaseId === null ? {} : { prereqCaseId: row.prereqCaseId }),
  };
}

export async function createCase(
  tx: TkTx,
  ctx: TenantContext,
  actor: Actor,
  input: CreateCaseInput,
): Promise<CaseSummaryDto> {
  const cases = new CaseRepo(tx, ctx);
  const revisions = new RevisionRepo(tx, ctx);
  const row = await cases.insertCase({
    projectId: input.projectId,
    name: input.name,
    isStepGroup: input.isStepGroup,
    ...(input.prereqCaseId === undefined ? {} : { prereqCaseId: input.prereqCaseId }),
    actorUserId: actor.userId,
  });
  // Revision #1 ghi NGAY cả khi case chưa có step: `latest` không bao giờ NULL sau
  // khi tạo, nên compiler luôn có bản để ghim (blueprint §4 phase 1).
  const revisionId = await revisions.insert({
    caseId: row.id,
    revisionNo: 1,
    caseVersion: 1,
    payload: { case: caseOf(row), steps: [] },
    actorUserId: actor.userId,
    note: "created",
  });
  const withRevision = await cases.setLatestRevision(row.id, revisionId);
  return toCaseSummary(withRevision);
}

export async function replaceSteps(
  tx: TkTx,
  ctx: TenantContext,
  actor: Actor,
  input: ReplaceStepsInput,
): Promise<CaseSummaryDto> {
  const cases = new CaseRepo(tx, ctx);
  const revisions = new RevisionRepo(tx, ctx);

  const row = await cases.findById(input.caseId);
  // Tenant khác ⇒ RLS đã lọc mất row ⇒ 404. KHÔNG BAO GIỜ 403 (blueprint §3 L3).
  if (row === undefined) throw new CaseNotFoundError(input.caseId);
  if (row.status === "in_review") {
    throw new CaseStateError(
      `Case ${input.caseId} đang in_review — rút review trước khi sửa (POST /cases/:id/withdraw-review)`,
    );
  }

  const existingRows = await cases.listStepRows(input.caseId);
  const existingIds = new Set(existingRows.map((s) => s.id));
  const flat = flattenStepInputs({
    caseId: input.caseId,
    steps: input.steps,
    existingIds,
    newId: () => randomUUID(),
  });
  const minePayload = buildRevisionPayload({
    case: caseOf(row),
    steps: flat.steps,
    loops: flat.loops,
    rests: flat.rests,
  });

  if (row.version !== input.expectedVersion) {
    const currentRevisionId = row.latestRevisionId;
    if (currentRevisionId === null) {
      throw new CaseStateError(`Case ${input.caseId} chưa có revision — dữ liệu không nhất quán`);
    }
    const base = await revisions.findByCaseVersion(input.caseId, input.expectedVersion);
    const theirs = await revisions.loadPayload(currentRevisionId);
    // Không tìm được revision của version client cầm (chỉ xảy ra sau can thiệp dữ
    // liệu thủ công): lấy bản hiện tại làm base — diff vẫn đúng chiều, chỉ kém tinh.
    const basePayload: RevisionPayload = base?.payload ?? theirs;
    throw new VersionConflictError(
      threeWayDiff({
        base: basePayload,
        mine: minePayload,
        theirs,
        baseVersion: input.expectedVersion,
        baseRevisionId: base?.id ?? currentRevisionId,
        currentVersion: row.version,
        currentRevisionId,
      }),
    );
  }

  await cases.deleteSteps(input.caseId);
  await cases.insertSteps(flat.steps, flat.loops, flat.rests);
  const nextVersion = row.version + 1;
  const revisionId = await revisions.insert({
    caseId: input.caseId,
    revisionNo: nextVersion,
    caseVersion: nextVersion,
    payload: minePayload,
    actorUserId: actor.userId,
    note: "steps replaced",
  });
  const updated = await cases.applyEdit(input.caseId, nextVersion, actor.userId, revisionId);
  return toCaseSummary(updated);
}
```

> `row.submittedAt!` trong `toCaseSummary` là chỗ `!` **có lý**: nhánh chỉ chạy khi `iso(...)` đã khác `undefined`, tức `row.submittedAt !== null`. Nếu muốn tránh hẳn `!`, viết `...(row.submittedAt === null ? {} : { submittedAt: row.submittedAt.toISOString() })` cho cả ba mốc — **ưu tiên cách này**, và bỏ hàm `iso` đi.

- [ ] **Step 6: Chạy test, xác nhận XANH**

Run: `cd testkite && pnpm --filter @testkite/core test test/authoring/case-service.test.ts`
Expected: PASS 8 test.

- [ ] **Step 7: Verify + commit**

Run: `cd testkite && pnpm typecheck && pnpm lint && pnpm --filter @testkite/core test`
Expected: xanh cả ba. (`pnpm lint` quan trọng: eslint-boundaries kiểm tra authoring chỉ import kernel/identity qua facade.)

```bash
git add testkite/apps/core/src/modules/authoring/db/case-repo.ts \
        testkite/apps/core/src/modules/authoring/db/revision-repo.ts \
        testkite/apps/core/src/modules/authoring/case-service.ts \
        testkite/apps/core/test/authoring/case-service.test.ts
git commit -m "M2-AUT T9: case service tao/sua + revision + 409 diff 3 chieu"
```

---

## Task 10 — `aut_case_reviews` + máy trạng thái submit / withdraw / decide

**Files:**
- Modify: `apps/core/src/modules/authoring/db/schema.ts` (bảng `autCaseReviews` + enum `aut_review_state`)
- Create: `apps/core/drizzle/0012_aut_case_reviews.sql` (sinh máy)
- Create: `apps/core/drizzle/0013_aut_case_reviews_grants.sql` (viết tay)
- Create: `apps/core/src/modules/authoring/db/review-repo.ts`
- Modify: `apps/core/src/modules/authoring/db/case-repo.ts` (thêm `applySubmit`, `applyDecision`)
- Create: `apps/core/src/modules/authoring/review-service.ts`
- Create: `apps/core/test/authoring/review-service.test.ts`

**Interfaces:**
- Consumes: `CaseRepo`, `RevisionRepo`, lỗi, `threeWayDiff`.
- Produces:
  - enum `aut_review_state` = `open` | `approved` | `changes_requested` | `withdrawn`
  - bảng `autCaseReviews` + **partial unique index** `aut_case_reviews_one_open` trên `(team_id, case_id) WHERE state = 'open'`
  - `class ReviewRepo extends TenantRepo` — `open`, `findOpen`, `findLatest`, `close`
  - `submitForReview(tx, ctx, actor, { caseId, expectedVersion })`
  - `withdrawReview(tx, ctx, actor, { caseId, expectedVersion })`
  - `decideReview(tx, ctx, actor, { caseId, expectedVersion, decision, comment? })`
  - `conflictFor(tx, ctx, caseId, expectedVersion, row): Promise<VersionConflictError>` — dựng 409 cho mutation KHÔNG mang payload

> **Máy trạng thái (một trang giấy, không nhiều hơn):**
> ```
> draft  --submit-->  in_review  --approve-->   in_review (reviewed_at đã đóng dấu)
>   ^                    |  |                        |
>   |                    |  +--changes_requested-->  draft
>   |                    +--withdraw-------------->  draft
>   |                                                  |
>   +---------------- edit (Task 9) <------- ready <--promote (Task 11)
> ```
> `approve` KHÔNG tự đẩy sang `ready`: promote là hành động riêng, có người riêng (four-eyes) và có advisory lock riêng.

- [ ] **Step 1: Viết test ĐỎ `apps/core/test/authoring/review-service.test.ts`**

```ts
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { withTenant } from "../../src/modules/kernel/index.js";
import { createCase, replaceSteps } from "../../src/modules/authoring/case-service.js";
import { decideReview, submitForReview, withdrawReview } from "../../src/modules/authoring/review-service.js";
import { CaseStateError, VersionConflictError } from "../../src/modules/authoring/errors.js";
import { makeTestDb, type TestDb } from "../harness/pglite.js";

let t: TestDb;
let teamId = "";
let projectId = "";
const alice = { userId: "" };
const bob = { userId: "" };

beforeAll(async () => {
  t = await makeTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  const org = await t.db.execute(sql`INSERT INTO organizations (name, slug) VALUES ('Acme','acme') RETURNING id`);
  const orgId = String(org.rows[0]?.["id"]);
  const team = await t.db.execute(sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},'A','a') RETURNING id`);
  teamId = String(team.rows[0]?.["id"]);
  const p = await t.db.execute(sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamId},'P','p') RETURNING id`);
  projectId = String(p.rows[0]?.["id"]);
  const u1 = await t.db.execute(sql`INSERT INTO users (email, display_name) VALUES ('a@x.test','Alice') RETURNING id`);
  const u2 = await t.db.execute(sql`INSERT INTO users (email, display_name) VALUES ('b@x.test','Bob') RETURNING id`);
  alice.userId = String(u1.rows[0]?.["id"]);
  bob.userId = String(u2.rows[0]?.["id"]);
});

const ctx = (): { teamId: string } => ({ teamId });

async function seedDraftWithSteps(): Promise<{ id: string; version: number }> {
  const created = await withTenant(t.db, ctx(), (tx) =>
    createCase(tx, ctx(), alice, { projectId, name: "Checkout", isStepGroup: false }),
  );
  const edited = await withTenant(t.db, ctx(), (tx) =>
    replaceSteps(tx, ctx(), alice, {
      caseId: created.id,
      expectedVersion: created.version,
      steps: [{ kind: "action", renderedSentence: "open login page", verbOpKey: "goto" }],
    }),
  );
  return { id: edited.id, version: edited.version };
}

describe("aut_case_reviews — hình dạng", () => {
  it("enum aut_review_state đúng 4 trạng thái", async () => {
    const r = await t.db.execute(sql`
      SELECT e.enumlabel FROM pg_enum e JOIN pg_type ty ON ty.oid = e.enumtypid
      WHERE ty.typname = 'aut_review_state' ORDER BY e.enumsortorder`);
    expect(r.rows.map((x) => x["enumlabel"])).toEqual(["open", "approved", "changes_requested", "withdrawn"]);
  });

  it("partial unique index chặn HAI review open trên cùng case", async () => {
    const c = await seedDraftWithSteps();
    const revId = await t.db.execute(sql`SELECT latest_revision_id AS r FROM aut_cases WHERE id = ${c.id}`);
    const revisionId = String(revId.rows[0]?.["r"]);
    const ins = sql`
      INSERT INTO aut_case_reviews (team_id, case_id, revision_id, state, requested_by)
      VALUES (${teamId},${c.id},${revisionId},'open',${alice.userId})`;
    await t.db.execute(ins);
    await expect(t.db.execute(ins)).rejects.toThrow(/duplicate key|unique/i);
  });

  it("hai review ĐÃ ĐÓNG trên cùng case thì được — index chỉ ràng buộc state='open'", async () => {
    const c = await seedDraftWithSteps();
    const revId = await t.db.execute(sql`SELECT latest_revision_id AS r FROM aut_cases WHERE id = ${c.id}`);
    const revisionId = String(revId.rows[0]?.["r"]);
    for (const state of ["approved", "changes_requested"]) {
      await t.db.execute(sql`
        INSERT INTO aut_case_reviews (team_id, case_id, revision_id, state, requested_by, decided_by, decided_at)
        VALUES (${teamId},${c.id},${revisionId},${state},${alice.userId},${bob.userId},now())`);
    }
    const r = await t.db.execute(sql`SELECT count(*)::int AS n FROM aut_case_reviews WHERE case_id = ${c.id}`);
    expect(r.rows[0]?.["n"]).toBe(2);
  });
});

describe("submitForReview", () => {
  it("draft -> in_review, đóng dấu submitted_at/submitted_by, mở review, bump version", async () => {
    const c = await seedDraftWithSteps();
    const after = await withTenant(t.db, ctx(), (tx) =>
      submitForReview(tx, ctx(), alice, { caseId: c.id, expectedVersion: c.version }),
    );
    expect(after.status).toBe("in_review");
    expect(after.submittedAt).toBeDefined();
    expect(after.version).toBe(c.version + 1);

    const r = await t.db.execute(sql`
      SELECT state, requested_by FROM aut_case_reviews WHERE case_id = ${c.id}`);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]?.["state"]).toBe("open");
    expect(r.rows[0]?.["requested_by"]).toBe(alice.userId);
  });

  it("submit lần hai khi đang in_review ⇒ CaseStateError", async () => {
    const c = await seedDraftWithSteps();
    const s = await withTenant(t.db, ctx(), (tx) =>
      submitForReview(tx, ctx(), alice, { caseId: c.id, expectedVersion: c.version }),
    );
    const err = await withTenant(t.db, ctx(), (tx) =>
      submitForReview(tx, ctx(), alice, { caseId: c.id, expectedVersion: s.version }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaseStateError);
  });

  it("version lệch ⇒ VersionConflictError, mine RỖNG (submit không gửi payload)", async () => {
    const c = await seedDraftWithSteps();
    const err = await withTenant(t.db, ctx(), (tx) =>
      submitForReview(tx, ctx(), alice, { caseId: c.id, expectedVersion: c.version - 1 }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VersionConflictError);
    expect((err as VersionConflictError).diff.mine).toEqual([]);
    expect((err as VersionConflictError).diff.currentVersion).toBe(c.version);
  });
});

describe("decideReview", () => {
  it("approved: đóng dấu reviewed_at/reviewed_by, GIỮ status in_review (promote là bước riêng)", async () => {
    const c = await seedDraftWithSteps();
    const s = await withTenant(t.db, ctx(), (tx) =>
      submitForReview(tx, ctx(), alice, { caseId: c.id, expectedVersion: c.version }),
    );
    const after = await withTenant(t.db, ctx(), (tx) =>
      decideReview(tx, ctx(), bob, { caseId: c.id, expectedVersion: s.version, decision: "approved" }),
    );
    expect(after.status).toBe("in_review");
    expect(after.reviewedAt).toBeDefined();
    const r = await t.db.execute(sql`SELECT state, decided_by FROM aut_case_reviews WHERE case_id = ${c.id}`);
    expect(r.rows[0]?.["state"]).toBe("approved");
    expect(r.rows[0]?.["decided_by"]).toBe(bob.userId);
  });

  it("changes_requested: quay về draft, review đóng, comment được lưu", async () => {
    const c = await seedDraftWithSteps();
    const s = await withTenant(t.db, ctx(), (tx) =>
      submitForReview(tx, ctx(), alice, { caseId: c.id, expectedVersion: c.version }),
    );
    const after = await withTenant(t.db, ctx(), (tx) =>
      decideReview(tx, ctx(), bob, {
        caseId: c.id,
        expectedVersion: s.version,
        decision: "changes_requested",
        comment: "thiếu bước xác nhận đơn",
      }),
    );
    expect(after.status).toBe("draft");
    const r = await t.db.execute(sql`SELECT state, comment FROM aut_case_reviews WHERE case_id = ${c.id}`);
    expect(r.rows[0]?.["state"]).toBe("changes_requested");
    expect(r.rows[0]?.["comment"]).toBe("thiếu bước xác nhận đơn");
  });

  it("decide khi case đang draft (không có review mở) ⇒ CaseStateError", async () => {
    const c = await seedDraftWithSteps();
    const err = await withTenant(t.db, ctx(), (tx) =>
      decideReview(tx, ctx(), bob, { caseId: c.id, expectedVersion: c.version, decision: "approved" }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaseStateError);
  });
});

describe("withdrawReview", () => {
  it("in_review -> draft và review chuyển withdrawn, mở đường sửa tiếp", async () => {
    const c = await seedDraftWithSteps();
    const s = await withTenant(t.db, ctx(), (tx) =>
      submitForReview(tx, ctx(), alice, { caseId: c.id, expectedVersion: c.version }),
    );
    const after = await withTenant(t.db, ctx(), (tx) =>
      withdrawReview(tx, ctx(), alice, { caseId: c.id, expectedVersion: s.version }),
    );
    expect(after.status).toBe("draft");
    const r = await t.db.execute(sql`SELECT state FROM aut_case_reviews WHERE case_id = ${c.id}`);
    expect(r.rows[0]?.["state"]).toBe("withdrawn");
    // và sau khi rút thì sửa được ngay (Task 9 chặn khi in_review)
    const edited = await withTenant(t.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), alice, {
        caseId: c.id,
        expectedVersion: after.version,
        steps: [{ kind: "action", renderedSentence: "open login page v2", verbOpKey: "goto" }],
      }),
    );
    expect(edited.version).toBe(after.version + 1);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm --filter @testkite/core test test/authoring/review-service.test.ts`
Expected: FAIL — `aut_review_state` không tồn tại.

- [ ] **Step 3: Thêm bảng review vào `apps/core/src/modules/authoring/db/schema.ts`**

Thêm `uniqueIndex` vào import từ `drizzle-orm/pg-core`, rồi thêm cuối file:

```ts
export const autReviewState = pgEnum("aut_review_state", [
  "open",
  "approved",
  "changes_requested",
  "withdrawn",
]);

/**
 * Bản ghi review, một dòng cho mỗi lần đưa case ra xét. Lịch sử giữ lại (không
 * xoá dòng cũ) nên UI thấy được case đã bị trả về sửa mấy lần.
 */
export const autCaseReviews = pgTable(
  "aut_case_reviews",
  {
    teamId: uuid("team_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id").notNull(),
    /** Bản CỤ THỂ được đưa ra xét — review một bản, không phải review "cái case". */
    revisionId: uuid("revision_id").notNull(),
    state: autReviewState("state").notNull().default("open"),
    requestedBy: uuid("requested_by").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    comment: text("comment"),
  },
  (t) => [
    unique("aut_case_reviews_team_id_unique").on(t.teamId, t.id),
    index("aut_case_reviews_case_idx").on(t.teamId, t.caseId, t.requestedAt),
    /**
     * Tối đa MỘT review đang mở cho mỗi case — ràng buộc ở DB chứ không ở service,
     * vì hai request submit song song sẽ cùng đọc "chưa có review nào" rồi cùng ghi.
     * Partial index (WHERE state='open') là cách duy nhất diễn đạt "unique có điều
     * kiện" trong Postgres. Đã kiểm chứng chạy trên PGlite 18.3 (spike 2026-08-28).
     */
    uniqueIndex("aut_case_reviews_one_open")
      .on(t.teamId, t.caseId)
      .where(sql`state = 'open'`),
    foreignKey({
      name: "aut_case_reviews_case_fk",
      columns: [t.teamId, t.caseId],
      foreignColumns: [autCases.teamId, autCases.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "aut_case_reviews_revision_fk",
      columns: [t.teamId, t.revisionId],
      foreignColumns: [autCaseRevisions.teamId, autCaseRevisions.id],
    }),
    check(
      "aut_case_reviews_decided_shape",
      sql`(state = 'open' AND decided_by IS NULL AND decided_at IS NULL)
       OR (state <> 'open' AND decided_at IS NOT NULL)`,
    ),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: appRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
  ],
).enableRLS();
```

- [ ] **Step 4: Sinh migration + grants**

Run: `cd testkite/apps/core && pnpm db:generate --name=aut_case_reviews`

**Kiểm tra bằng mắt:** file sinh ra phải chứa `CREATE UNIQUE INDEX "aut_case_reviews_one_open" ON "aut_case_reviews" USING btree ("team_id","case_id") WHERE state = 'open';`. Nếu **thiếu mệnh đề `WHERE`**, xoá dòng index đó khỏi file sinh máy và đưa câu `CREATE UNIQUE INDEX ... WHERE state = 'open';` xuống file grants viết tay ở dưới (partial index là ràng buộc đúng đắn, không được rơi mất).

Tạo `apps/core/drizzle/0013_aut_case_reviews_grants.sql`:

```sql
-- Phần drizzle-kit KHÔNG sinh: GRANT (xem 0002_rls_hardening.sql).
-- Review CÓ UPDATE (đóng review = đổi state) nhưng KHÔNG có DELETE: lịch sử ai
-- yêu cầu, ai duyệt, duyệt lúc nào là bằng chứng four-eyes — xoá được thì four-eyes
-- chỉ còn là lời kể.
GRANT SELECT, INSERT, UPDATE ON aut_case_reviews TO "testkite_app";
```

Thêm entry `_journal.json` (`"tag": "0013_aut_case_reviews_grants"`).

- [ ] **Step 5: Implement `apps/core/src/modules/authoring/db/review-repo.ts`**

```ts
import { and, desc, eq } from "drizzle-orm";
import { TenantRepo, type TenantContext, type TkTx } from "../../kernel/index.js";
import { autCaseReviews } from "./schema.js";

export type ReviewRow = typeof autCaseReviews.$inferSelect;
export type ReviewClosedState = "approved" | "changes_requested" | "withdrawn";

export class ReviewRepo extends TenantRepo {
  constructor(tx: TkTx, ctx: TenantContext) {
    super(tx, ctx);
  }

  async open(caseId: string, revisionId: string, requestedBy: string): Promise<ReviewRow> {
    const rows = await this.tx
      .insert(autCaseReviews)
      .values({ teamId: this.teamId, caseId, revisionId, state: "open", requestedBy })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("aut_case_reviews: INSERT không trả row");
    return row;
  }

  async findOpen(caseId: string): Promise<ReviewRow | undefined> {
    const rows = await this.tx
      .select()
      .from(autCaseReviews)
      .where(
        and(
          eq(autCaseReviews.teamId, this.teamId),
          eq(autCaseReviews.caseId, caseId),
          eq(autCaseReviews.state, "open"),
        ),
      )
      .limit(1);
    return rows[0];
  }

  async findLatest(caseId: string): Promise<ReviewRow | undefined> {
    const rows = await this.tx
      .select()
      .from(autCaseReviews)
      .where(and(eq(autCaseReviews.teamId, this.teamId), eq(autCaseReviews.caseId, caseId)))
      .orderBy(desc(autCaseReviews.requestedAt), desc(autCaseReviews.id))
      .limit(1);
    return rows[0];
  }

  async close(
    reviewId: string,
    state: ReviewClosedState,
    decidedBy: string,
    comment?: string | undefined,
  ): Promise<ReviewRow> {
    const rows = await this.tx
      .update(autCaseReviews)
      .set({
        state,
        decidedBy,
        decidedAt: new Date(),
        ...(comment === undefined ? {} : { comment }),
      })
      .where(and(eq(autCaseReviews.teamId, this.teamId), eq(autCaseReviews.id, reviewId)))
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("aut_case_reviews: UPDATE không trả row");
    return row;
  }
}
```

- [ ] **Step 6: Thêm hai phương thức vào `apps/core/src/modules/authoring/db/case-repo.ts`**

```ts
  /** draft -> in_review. Bump version vì trạng thái đổi cũng là một thay đổi. */
  async applySubmit(caseId: string, nextVersion: number, actorUserId: string, revisionId: string): Promise<CaseRow> {
    const rows = await this.tx
      .update(autCases)
      .set({
        version: nextVersion,
        status: "in_review",
        submittedAt: new Date(),
        submittedBy: actorUserId,
        updatedAt: new Date(),
        latestRevisionId: revisionId,
      })
      .where(and(eq(autCases.teamId, this.teamId), eq(autCases.id, caseId)))
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("aut_cases: UPDATE không trả row");
    return row;
  }

  /**
   * Kết quả review. `approved` GIỮ in_review (promote là bước riêng);
   * `changes_requested` và `withdraw` đưa về draft.
   */
  async applyDecision(
    caseId: string,
    nextVersion: number,
    nextStatus: "draft" | "in_review",
    reviewer: { readonly userId: string; readonly stampReviewed: boolean },
  ): Promise<CaseRow> {
    const rows = await this.tx
      .update(autCases)
      .set({
        version: nextVersion,
        status: nextStatus,
        updatedAt: new Date(),
        ...(reviewer.stampReviewed ? { reviewedAt: new Date(), reviewedBy: reviewer.userId } : {}),
      })
      .where(and(eq(autCases.teamId, this.teamId), eq(autCases.id, caseId)))
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("aut_cases: UPDATE không trả row");
    return row;
  }
```

- [ ] **Step 7: Implement `apps/core/src/modules/authoring/review-service.ts`**

```ts
/**
 * Máy trạng thái review. Mọi hàm nhận TkTx (chạy trong withTenant) và đòi
 * `expectedVersion` — đổi trạng thái cũng là mutation, cũng phải mang If-Match.
 */
import type { CaseSummaryDto, ReviewDecisionDto } from "@testkite/contract";
import type { TenantContext, TkTx } from "../kernel/index.js";
import { CaseRepo, type CaseRow } from "./db/case-repo.js";
import { ReviewRepo } from "./db/review-repo.js";
import { RevisionRepo } from "./db/revision-repo.js";
import { toCaseSummary, type Actor } from "./case-service.js";
import { CaseNotFoundError, CaseStateError, VersionConflictError } from "./errors.js";
import { threeWayDiff } from "./revision/diff.js";

export interface CaseMutationInput {
  readonly caseId: string;
  readonly expectedVersion: number;
}

export interface DecideReviewInput extends CaseMutationInput {
  readonly decision: ReviewDecisionDto;
  readonly comment?: string | undefined;
}

/**
 * 409 cho mutation KHÔNG mang payload (submit/withdraw/decide/promote): `mine` là
 * chính base nên nhánh "mine" rỗng — client không đề xuất thay đổi nội dung nào,
 * nó chỉ đang đứng trên một bản cũ. Nhánh `theirs` vẫn cho thấy đã có gì đổi.
 */
async function conflictFor(
  tx: TkTx,
  ctx: TenantContext,
  row: CaseRow,
  expectedVersion: number,
): Promise<VersionConflictError> {
  const revisions = new RevisionRepo(tx, ctx);
  const currentRevisionId = row.latestRevisionId;
  if (currentRevisionId === null) {
    throw new CaseStateError(`Case ${row.id} chưa có revision — dữ liệu không nhất quán`);
  }
  const theirs = await revisions.loadPayload(currentRevisionId);
  const base = await revisions.findByCaseVersion(row.id, expectedVersion);
  const basePayload = base?.payload ?? theirs;
  return new VersionConflictError(
    threeWayDiff({
      base: basePayload,
      mine: basePayload,
      theirs,
      baseVersion: expectedVersion,
      baseRevisionId: base?.id ?? currentRevisionId,
      currentVersion: row.version,
      currentRevisionId,
    }),
  );
}

async function loadForMutation(
  tx: TkTx,
  ctx: TenantContext,
  input: CaseMutationInput,
): Promise<CaseRow> {
  const row = await new CaseRepo(tx, ctx).findById(input.caseId);
  if (row === undefined) throw new CaseNotFoundError(input.caseId);
  if (row.version !== input.expectedVersion) throw await conflictFor(tx, ctx, row, input.expectedVersion);
  return row;
}

export async function submitForReview(
  tx: TkTx,
  ctx: TenantContext,
  actor: Actor,
  input: CaseMutationInput,
): Promise<CaseSummaryDto> {
  const row = await loadForMutation(tx, ctx, input);
  if (row.status !== "draft") {
    throw new CaseStateError(`Chỉ case draft mới submit được; case ${row.id} đang ${row.status}`);
  }
  const revisionId = row.latestRevisionId;
  if (revisionId === null) throw new CaseStateError(`Case ${row.id} chưa có revision để đưa ra review`);

  const nextVersion = row.version + 1;
  const revisions = new RevisionRepo(tx, ctx);
  // Ghi một revision mốc cho chính lần submit: bản được review là một điểm cố định
  // trong lịch sử, không phải "bản mới nhất lúc ai đó mở trang".
  const submittedRevisionId = await revisions.insert({
    caseId: row.id,
    revisionNo: nextVersion,
    caseVersion: nextVersion,
    payload: await revisions.loadPayload(revisionId),
    actorUserId: actor.userId,
    note: "submitted for review",
  });
  await new ReviewRepo(tx, ctx).open(row.id, submittedRevisionId, actor.userId);
  const updated = await new CaseRepo(tx, ctx).applySubmit(row.id, nextVersion, actor.userId, submittedRevisionId);
  return toCaseSummary(updated);
}

export async function withdrawReview(
  tx: TkTx,
  ctx: TenantContext,
  actor: Actor,
  input: CaseMutationInput,
): Promise<CaseSummaryDto> {
  const row = await loadForMutation(tx, ctx, input);
  if (row.status !== "in_review") {
    throw new CaseStateError(`Không có review để rút; case ${row.id} đang ${row.status}`);
  }
  const reviews = new ReviewRepo(tx, ctx);
  const open = await reviews.findOpen(row.id);
  if (open === undefined) throw new CaseStateError(`Case ${row.id} không có review đang mở`);
  await reviews.close(open.id, "withdrawn", actor.userId);
  const updated = await new CaseRepo(tx, ctx).applyDecision(row.id, row.version + 1, "draft", {
    userId: actor.userId,
    stampReviewed: false,
  });
  return toCaseSummary(updated);
}

export async function decideReview(
  tx: TkTx,
  ctx: TenantContext,
  actor: Actor,
  input: DecideReviewInput,
): Promise<CaseSummaryDto> {
  const row = await loadForMutation(tx, ctx, input);
  if (row.status !== "in_review") {
    throw new CaseStateError(`Chỉ case in_review mới review được; case ${row.id} đang ${row.status}`);
  }
  const reviews = new ReviewRepo(tx, ctx);
  const open = await reviews.findOpen(row.id);
  if (open === undefined) throw new CaseStateError(`Case ${row.id} không có review đang mở`);

  await reviews.close(open.id, input.decision, actor.userId, input.comment);
  const approved = input.decision === "approved";
  const updated = await new CaseRepo(tx, ctx).applyDecision(
    row.id,
    row.version + 1,
    approved ? "in_review" : "draft",
    { userId: actor.userId, stampReviewed: approved },
  );
  return toCaseSummary(updated);
}
```

- [ ] **Step 8: Chạy test, xác nhận XANH**

Run: `cd testkite && pnpm --filter @testkite/core test test/authoring/review-service.test.ts`
Expected: PASS 9 test.

- [ ] **Step 9: Verify + commit**

Run: `cd testkite && pnpm typecheck && pnpm lint && pnpm --filter @testkite/core test`

```bash
git add testkite/apps/core/src/modules/authoring/ testkite/apps/core/drizzle/ \
        testkite/apps/core/test/authoring/review-service.test.ts
git commit -m "M2-AUT T10: aut_case_reviews + may trang thai submit/withdraw/decide"
```

---

## Task 11 — Promote: advisory lock `(team, case)` + four-eyes

**Files:**
- Modify: `apps/core/src/modules/authoring/db/case-repo.ts` (`applyPromote`, `lockCase`)
- Modify: `apps/core/src/modules/authoring/review-service.ts` (`promoteCase`)
- Create: `apps/core/test/authoring/promote.test.ts`

**Interfaces:**
- Consumes: `ReviewRepo.findLatest`, `teams` (facade identity), lỗi Task 7.
- Produces:
  - `CaseRepo.lockCase(caseId: string): Promise<void>` — `pg_advisory_xact_lock(hashtextextended(team||':'||case, 0))`
  - `CaseRepo.applyPromote(caseId, nextVersion, actorUserId, readyRevisionId): Promise<CaseRow>`
  - `promoteCase(tx, ctx, actor, { caseId, expectedVersion }): Promise<CaseSummaryDto>`

> **Thứ tự bắt buộc trong `promoteCase` (đổi thứ tự là mở lại race):**
> 1. **LẤY ADVISORY LOCK TRƯỚC MỌI THỨ.** Lấy sau khi đọc case thì hai promote song song cùng đọc `in_review` rồi cùng đi tiếp.
> 2. Đọc case (404 nếu không thấy) → 3. kiểm version (409) → 4. kiểm `status = in_review` (409) → 5. kiểm review mới nhất là `approved` (409) → 6. **four-eyes** (403) → 7. ghi.
>
> `pg_advisory_xact_lock` **tự nhả khi transaction kết thúc** (spike: `pg_locks` còn 0 sau COMMIT) — không có `unlock` nào để quên. Khoá là `hashtextextended(team_id || ':' || case_id, 0)`; hai case khác nhau ra hai khoá khác nhau (spike đo: `t1:c1` → 4507270282684556902, `t1:c2` → 8661962171965904302). Đụng độ hash chỉ khiến hai promote không liên quan xếp hàng — vô hại.
>
> **Four-eyes** (blueprint §3): `row.lastEditedBy === actor.userId` ⇒ 403, **trừ khi** `teams.allow_self_promote = true`. Chỉ áp ở **promote**, không áp ở review: spec nói "người-sửa-cuối-không-tự-**promote**". Người sửa duyệt bản của người khác vẫn hợp lệ.

- [ ] **Step 1: Viết test ĐỎ `apps/core/test/authoring/promote.test.ts`**

```ts
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { withTenant } from "../../src/modules/kernel/index.js";
import { createCase, replaceSteps } from "../../src/modules/authoring/case-service.js";
import { decideReview, promoteCase, submitForReview } from "../../src/modules/authoring/review-service.js";
import { CaseStateError, FourEyesViolationError } from "../../src/modules/authoring/errors.js";
import { makeTestDb, type TestDb } from "../harness/pglite.js";

let t: TestDb;
let teamId = "";
let projectId = "";
const alice = { userId: "" };
const bob = { userId: "" };

beforeAll(async () => {
  t = await makeTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  const org = await t.db.execute(sql`INSERT INTO organizations (name, slug) VALUES ('Acme','acme') RETURNING id`);
  const orgId = String(org.rows[0]?.["id"]);
  const team = await t.db.execute(sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},'A','a') RETURNING id`);
  teamId = String(team.rows[0]?.["id"]);
  const p = await t.db.execute(sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamId},'P','p') RETURNING id`);
  projectId = String(p.rows[0]?.["id"]);
  const u1 = await t.db.execute(sql`INSERT INTO users (email, display_name) VALUES ('a@x.test','Alice') RETURNING id`);
  const u2 = await t.db.execute(sql`INSERT INTO users (email, display_name) VALUES ('b@x.test','Bob') RETURNING id`);
  alice.userId = String(u1.rows[0]?.["id"]);
  bob.userId = String(u2.rows[0]?.["id"]);
});

const ctx = (): { teamId: string } => ({ teamId });

/** Alice sửa, Alice submit, Bob duyệt. Trả về (caseId, version sau khi duyệt). */
async function approvedCase(): Promise<{ id: string; version: number }> {
  const created = await withTenant(t.db, ctx(), (tx) =>
    createCase(tx, ctx(), alice, { projectId, name: "Checkout", isStepGroup: false }),
  );
  const edited = await withTenant(t.db, ctx(), (tx) =>
    replaceSteps(tx, ctx(), alice, {
      caseId: created.id,
      expectedVersion: created.version,
      steps: [{ kind: "action", renderedSentence: "open login page", verbOpKey: "goto" }],
    }),
  );
  const submitted = await withTenant(t.db, ctx(), (tx) =>
    submitForReview(tx, ctx(), alice, { caseId: edited.id, expectedVersion: edited.version }),
  );
  const decided = await withTenant(t.db, ctx(), (tx) =>
    decideReview(tx, ctx(), bob, { caseId: edited.id, expectedVersion: submitted.version, decision: "approved" }),
  );
  return { id: decided.id, version: decided.version };
}

describe("promoteCase", () => {
  it("người KHÁC người sửa cuối promote được: status ready, ready_revision_id được ghim", async () => {
    const c = await approvedCase();
    const after = await withTenant(t.db, ctx(), (tx) =>
      promoteCase(tx, ctx(), bob, { caseId: c.id, expectedVersion: c.version }),
    );
    expect(after.status).toBe("ready");
    expect(after.promotedAt).toBeDefined();
    expect(after.readyRevisionId).toBeDefined();
    expect(after.readyRevisionId).toBe(after.latestRevisionId);
  });

  it("FOUR-EYES: người sửa cuối tự promote ⇒ 403 FourEyesViolationError", async () => {
    const c = await approvedCase();
    const err = await withTenant(t.db, ctx(), (tx) =>
      promoteCase(tx, ctx(), alice, { caseId: c.id, expectedVersion: c.version }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FourEyesViolationError);
    expect((err as FourEyesViolationError).httpStatus).toBe(403);
  });

  it("teams.allow_self_promote = true ⇒ người sửa cuối tự promote ĐƯỢC", async () => {
    const c = await approvedCase();
    await t.db.execute(sql`UPDATE teams SET allow_self_promote = true WHERE id = ${teamId}`);
    const after = await withTenant(t.db, ctx(), (tx) =>
      promoteCase(tx, ctx(), alice, { caseId: c.id, expectedVersion: c.version }),
    );
    expect(after.status).toBe("ready");
  });

  it("promote khi chưa được duyệt ⇒ CaseStateError", async () => {
    const created = await withTenant(t.db, ctx(), (tx) =>
      createCase(tx, ctx(), alice, { projectId, name: "C", isStepGroup: false }),
    );
    const submitted = await withTenant(t.db, ctx(), (tx) =>
      submitForReview(tx, ctx(), alice, { caseId: created.id, expectedVersion: created.version }),
    );
    const err = await withTenant(t.db, ctx(), (tx) =>
      promoteCase(tx, ctx(), bob, { caseId: created.id, expectedVersion: submitted.version }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaseStateError);
  });

  it("promote khi review bị changes_requested ⇒ CaseStateError", async () => {
    const created = await withTenant(t.db, ctx(), (tx) =>
      createCase(tx, ctx(), alice, { projectId, name: "C", isStepGroup: false }),
    );
    const submitted = await withTenant(t.db, ctx(), (tx) =>
      submitForReview(tx, ctx(), alice, { caseId: created.id, expectedVersion: created.version }),
    );
    const rejected = await withTenant(t.db, ctx(), (tx) =>
      decideReview(tx, ctx(), bob, {
        caseId: created.id,
        expectedVersion: submitted.version,
        decision: "changes_requested",
      }),
    );
    const err = await withTenant(t.db, ctx(), (tx) =>
      promoteCase(tx, ctx(), bob, { caseId: created.id, expectedVersion: rejected.version }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaseStateError);
  });

  it("sửa case đã ready đưa về draft NHƯNG GIỮ ready_revision_id (lịch đêm vẫn chạy bản cũ)", async () => {
    const c = await approvedCase();
    const promoted = await withTenant(t.db, ctx(), (tx) =>
      promoteCase(tx, ctx(), bob, { caseId: c.id, expectedVersion: c.version }),
    );
    const edited = await withTenant(t.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), alice, {
        caseId: c.id,
        expectedVersion: promoted.version,
        steps: [{ kind: "action", renderedSentence: "open login page v2", verbOpKey: "goto" }],
      }),
    );
    expect(edited.status).toBe("draft");
    expect(edited.readyRevisionId).toBe(promoted.readyRevisionId);
    expect(edited.latestRevisionId).not.toBe(promoted.readyRevisionId);
  });

  it("advisory lock NHẢ SẠCH sau khi transaction đóng — không rò khoá qua pool", async () => {
    const c = await approvedCase();
    await withTenant(t.db, ctx(), (tx) =>
      promoteCase(tx, ctx(), bob, { caseId: c.id, expectedVersion: c.version }),
    );
    // pg_advisory_xact_lock tự nhả khi COMMIT (spike 2026-08-28). Nếu ai đó đổi sang
    // pg_advisory_lock (session-scope) thì test này ĐỎ ngay — đó là mục đích của nó.
    const after = await t.db.execute(sql`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`);
    expect(after.rows[0]?.["n"]).toBe(0);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm --filter @testkite/core test test/authoring/promote.test.ts`
Expected: FAIL — `promoteCase` không được export.

- [ ] **Step 3: Thêm `lockCase` + `applyPromote` vào `apps/core/src/modules/authoring/db/case-repo.ts`**

Thêm `sql` vào import từ `drizzle-orm`, rồi thêm hai phương thức:

```ts
  /**
   * Advisory lock theo (team, case), phạm vi TRANSACTION.
   *
   * `pg_advisory_xact_lock` tự nhả khi COMMIT/ROLLBACK (spike 2026-08-28: pg_locks
   * còn 0 sau COMMIT) nên không tồn tại đường rò lock. KHÔNG dùng bản session-scope
   * `pg_advisory_lock`: nó sống qua cả connection trong pool và sẽ rò thật.
   * Khoá là hashtextextended của "team:case" — role app gọi được (đã kiểm chứng
   * dưới role NOLOGIN NOSUPERUSER NOBYPASSRLS).
   */
  async lockCase(caseId: string): Promise<void> {
    await this.tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.teamId} || ':' || ${caseId}, 0))`,
    );
  }

  /** in_review (đã approved) -> ready. GHIM ready_revision_id = bản đang latest. */
  async applyPromote(
    caseId: string,
    nextVersion: number,
    actorUserId: string,
    readyRevisionId: string,
  ): Promise<CaseRow> {
    const rows = await this.tx
      .update(autCases)
      .set({
        version: nextVersion,
        status: "ready",
        promotedAt: new Date(),
        promotedBy: actorUserId,
        updatedAt: new Date(),
        readyRevisionId,
      })
      .where(and(eq(autCases.teamId, this.teamId), eq(autCases.id, caseId)))
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("aut_cases: UPDATE không trả row");
    return row;
  }
```

- [ ] **Step 4: Thêm `promoteCase` vào `apps/core/src/modules/authoring/review-service.ts`**

Thêm import (xuôi DAG — `teams` lấy từ **facade** identity, không chạm `identity/db/schema.js`):

```ts
import { and, eq } from "drizzle-orm";
import { teams } from "../identity/index.js";
import { FourEyesViolationError } from "./errors.js";
```

và hàm:

```ts
/**
 * draft/in_review -> ready. THỨ TỰ DƯỚI ĐÂY LÀ MỘT PHẦN CỦA TÍNH ĐÚNG ĐẮN:
 *   1. advisory lock TRƯỚC khi đọc bất cứ thứ gì — lấy sau khi đọc thì hai promote
 *      song song cùng thấy `in_review` rồi cùng đi tiếp;
 *   2. rồi mới đọc case / kiểm version / kiểm trạng thái / kiểm four-eyes / ghi.
 */
export async function promoteCase(
  tx: TkTx,
  ctx: TenantContext,
  actor: Actor,
  input: CaseMutationInput,
): Promise<CaseSummaryDto> {
  const cases = new CaseRepo(tx, ctx);
  await cases.lockCase(input.caseId);

  const row = await cases.findById(input.caseId);
  if (row === undefined) throw new CaseNotFoundError(input.caseId);
  if (row.version !== input.expectedVersion) throw await conflictFor(tx, ctx, row, input.expectedVersion);
  if (row.status !== "in_review") {
    throw new CaseStateError(`Chỉ case in_review mới promote được; case ${row.id} đang ${row.status}`);
  }

  const latestReview = await new ReviewRepo(tx, ctx).findLatest(row.id);
  if (latestReview === undefined || latestReview.state !== "approved") {
    throw new CaseStateError(`Case ${row.id} chưa được duyệt — promote cần một review 'approved'`);
  }

  // FOUR-EYES (blueprint §3). Cờ nằm ở teams, đọc qua facade identity (xuôi DAG).
  if (row.lastEditedBy === actor.userId) {
    const teamRows = await tx
      .select({ allowSelfPromote: teams.allowSelfPromote })
      .from(teams)
      .where(and(eq(teams.id, ctx.teamId)))
      .limit(1);
    const allowSelfPromote = teamRows[0]?.allowSelfPromote ?? false;
    if (!allowSelfPromote) throw new FourEyesViolationError(row.id);
  }

  const readyRevisionId = row.latestRevisionId;
  if (readyRevisionId === null) throw new CaseStateError(`Case ${row.id} chưa có revision để ghim`);

  const nextVersion = row.version + 1;
  const updated = await cases.applyPromote(row.id, nextVersion, actor.userId, readyRevisionId);
  return toCaseSummary(updated);
}
```

> Thêm `import { CaseNotFoundError }` nếu chưa có trong file (Task 10 đã import). `promoteCase` **không** ghi revision mới: nội dung case không đổi, chỉ có con trỏ `ready_revision_id` dịch chuyển — ghi thêm một bản y hệt chỉ làm phình lịch sử. `version` vẫn bump vì ETag của case đã đổi.

- [ ] **Step 5: Chạy test, xác nhận XANH**

Run: `cd testkite && pnpm --filter @testkite/core test test/authoring/promote.test.ts`
Expected: PASS 7 test.

- [ ] **Step 6: Verify + commit**

Run: `cd testkite && pnpm typecheck && pnpm lint && pnpm --filter @testkite/core test`

```bash
git add testkite/apps/core/src/modules/authoring/ testkite/apps/core/test/authoring/promote.test.ts
git commit -m "M2-AUT T11: promote advisory lock + four-eyes (allow_self_promote)"
```

---

## Task 12 — Tranh chấp THẬT: hai promote song song trên Postgres thật

**Files:**
- Create: `apps/core/test/concurrency/promote-lock.test.ts`

**Interfaces:**
- Consumes: `describeRealPg`, `makeRealDb` (`test/harness/realpg.ts`, có sẵn từ M1); `promoteCase`, `createCase`, `replaceSteps`, `submitForReview`, `decideReview`.
- Produces: không có kiểu mới — task này chỉ sinh **bằng chứng**.

> **Vì sao bắt buộc có task riêng:** Task 11 chạy trên PGlite, mà PGlite chỉ có **một connection** — hai `db.transaction()` "song song" chỉ xếp hàng tuần tự (spike M1). Advisory lock ở đó **không bao giờ bị tranh chấp**, nên test Task 11 chứng minh được "lock có được lấy", KHÔNG chứng minh được "lock có tác dụng". Bằng chứng đó chỉ tồn tại trên Postgres thật, hai connection thật.
>
> Local: `bash scripts/test-pg.sh` (đã có từ M1) dựng cluster tạm rồi export `TESTKITE_TEST_PG_URL`. Không có biến ⇒ suite tự skip, `pnpm test` vẫn xanh. CI job `postgres:17` luôn set biến ⇒ **CI là nơi bằng chứng này thật sự được thu**.

- [ ] **Step 1: Viết test ĐỎ `apps/core/test/concurrency/promote-lock.test.ts`**

```ts
import { expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { withTenant } from "../../src/modules/kernel/index.js";
import { createCase, replaceSteps } from "../../src/modules/authoring/case-service.js";
import { decideReview, promoteCase, submitForReview } from "../../src/modules/authoring/review-service.js";
import { describeRealPg, makeRealDb, type RealDb } from "../harness/realpg.js";

describeRealPg("promote dưới tranh chấp thật (Postgres 17)", () => {
  let r: RealDb;
  let teamId = "";
  let projectId = "";
  const alice = { userId: "" };
  const bob = { userId: "" };
  const carol = { userId: "" };

  beforeAll(async () => {
    r = await makeRealDb();
  });
  afterAll(async () => {
    await r.close();
  });

  beforeEach(async () => {
    await r.db.execute(sql`
      TRUNCATE aut_case_reviews, aut_case_revisions, aut_rest_steps, aut_step_loops, aut_steps,
               aut_cases, memberships, projects, teams, users, organizations RESTART IDENTITY CASCADE`);
    const org = await r.db.execute(sql`INSERT INTO organizations (name, slug) VALUES ('Acme','acme') RETURNING id`);
    const orgId = String(org.rows[0]?.["id"]);
    const team = await r.db.execute(sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},'A','a') RETURNING id`);
    teamId = String(team.rows[0]?.["id"]);
    const p = await r.db.execute(sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamId},'P','p') RETURNING id`);
    projectId = String(p.rows[0]?.["id"]);
    for (const [email, name, holder] of [
      ["a@x.test", "Alice", alice],
      ["b@x.test", "Bob", bob],
      ["c@x.test", "Carol", carol],
    ] as const) {
      const u = await r.db.execute(
        sql`INSERT INTO users (email, display_name) VALUES (${email},${name}) RETURNING id`,
      );
      holder.userId = String(u.rows[0]?.["id"]);
    }
  });

  const ctx = (): { teamId: string } => ({ teamId });

  async function approvedCase(): Promise<{ id: string; version: number }> {
    const created = await withTenant(r.db, ctx(), (tx) =>
      createCase(tx, ctx(), alice, { projectId, name: "Checkout", isStepGroup: false }),
    );
    const edited = await withTenant(r.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), alice, {
        caseId: created.id,
        expectedVersion: created.version,
        steps: [{ kind: "action", renderedSentence: "open login page", verbOpKey: "goto" }],
      }),
    );
    const submitted = await withTenant(r.db, ctx(), (tx) =>
      submitForReview(tx, ctx(), alice, { caseId: edited.id, expectedVersion: edited.version }),
    );
    const decided = await withTenant(r.db, ctx(), (tx) =>
      decideReview(tx, ctx(), bob, { caseId: edited.id, expectedVersion: submitted.version, decision: "approved" }),
    );
    return { id: decided.id, version: decided.version };
  }

  it("hai promote song song: ĐÚNG MỘT cái thắng, cái kia thất bại có kiểm soát", async () => {
    const c = await approvedCase();
    const attempt = (): Promise<unknown> =>
      withTenant(r.db, ctx(), (tx) => promoteCase(tx, ctx(), bob, { caseId: c.id, expectedVersion: c.version }))
        .then(() => "ok" as const)
        .catch((e: unknown) => e);

    const [x, y] = await Promise.all([attempt(), attempt()]);
    const okCount = [x, y].filter((v) => v === "ok").length;
    expect(okCount).toBe(1);

    // Cái thua KHÔNG được là lỗi hạ tầng — phải là 409 (version đã bị cái thắng bump).
    const loser = [x, y].find((v) => v !== "ok");
    expect((loser as { httpStatus?: number }).httpStatus).toBe(409);
  });

  it("promote nối tiếp không sinh ready_revision_id lung tung — đúng 1 row ready", async () => {
    const c = await approvedCase();
    await Promise.all([
      withTenant(r.db, ctx(), (tx) =>
        promoteCase(tx, ctx(), bob, { caseId: c.id, expectedVersion: c.version }),
      ).catch(() => undefined),
      withTenant(r.db, ctx(), (tx) =>
        promoteCase(tx, ctx(), carol, { caseId: c.id, expectedVersion: c.version }),
      ).catch(() => undefined),
    ]);
    const res = await r.db.execute(sql`
      SELECT status, version, ready_revision_id, promoted_by FROM aut_cases WHERE id = ${c.id}`);
    expect(res.rows.length).toBe(1);
    expect(res.rows[0]?.["status"]).toBe("ready");
    expect(Number(res.rows[0]?.["version"])).toBe(c.version + 1);
    expect(res.rows[0]?.["ready_revision_id"]).not.toBeNull();
  });

  it("advisory lock THẬT SỰ chặn: giữ khoá ở connection A thì connection B phải chờ", async () => {
    const c = await approvedCase();
    const a = await r.pool.connect();
    const b = await r.pool.connect();
    try {
      await a.query("BEGIN");
      await a.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))`, [teamId, c.id]);

      let bAcquired = false;
      const bPromise = (async () => {
        await b.query("BEGIN");
        await b.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))`, [teamId, c.id]);
        bAcquired = true;
        await b.query("COMMIT");
      })();

      await new Promise((resolve) => setTimeout(resolve, 300));
      // Bằng chứng lock có tranh chấp thật — thứ PGlite KHÔNG THỂ chứng minh.
      expect(bAcquired).toBe(false);

      await a.query("COMMIT");
      await bPromise;
      expect(bAcquired).toBe(true);
    } finally {
      a.release();
      b.release();
    }
  });

  it("khoá của case KHÁC không chặn nhau (khoá theo (team, case), không phải khoá toàn cục)", async () => {
    const c1 = await approvedCase();
    const a = await r.pool.connect();
    const b = await r.pool.connect();
    try {
      await a.query("BEGIN");
      await a.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))`, [teamId, c1.id]);
      await b.query("BEGIN");
      // case id khác ⇒ khoá khác ⇒ lấy được ngay, không chờ.
      await b.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))`, [
        teamId,
        "00000000-0000-0000-0000-0000000000ff",
      ]);
      await b.query("COMMIT");
      await a.query("COMMIT");
      expect(true).toBe(true);
    } finally {
      a.release();
      b.release();
    }
  });
});
```

- [ ] **Step 2: Chạy trên máy KHÔNG có Postgres, xác nhận SKIP**

Run: `cd testkite && pnpm --filter @testkite/core test test/concurrency/promote-lock.test.ts`
Expected: suite bị skip (không có `TESTKITE_TEST_PG_URL`), exit code 0.

- [ ] **Step 3: Dựng Postgres thật rồi chạy, xác nhận XANH**

```bash
cd testkite && bash scripts/test-pg.sh   # in ra TESTKITE_TEST_PG_URL
export TESTKITE_TEST_PG_URL=postgres://postgres@127.0.0.1:55432/postgres
pnpm --filter @testkite/core test test/concurrency/promote-lock.test.ts
```

Expected: PASS 4 test. **Dán output thật vào commit message hoặc PR** — đây là bằng chứng duy nhất cho câu "advisory lock hoạt động"; nếu chỉ chạy trên PGlite thì bạn chưa chứng minh gì cả (`verification-before-completion`).

- [ ] **Step 4: Commit**

```bash
git add testkite/apps/core/test/concurrency/promote-lock.test.ts
git commit -m "M2-AUT T12: test tranh chap that - advisory lock serialize promote"
```

---

## Task 13 — `buildCompileSnapshot()`: nối authoring với run-compiler

**Files:**
- Create: `apps/core/src/modules/authoring/snapshot.ts`
- Create: `apps/core/test/authoring/snapshot.test.ts`
- Modify: `apps/core/src/modules/authoring/index.ts` (facade)

**Interfaces:**
- Consumes: `CaseRepo`, `RevisionRepo`, `RevisionPayload`; DTO `CompileSnapshotDto`, `AuthoredCaseDto`, `AuthoredStepDto`, `ElementDto`, `DataProfileDto`, `EnvDto` (`@testkite/contract`).
- Produces:
  - `type SnapshotPin = "ready" | "latest"`
  - `interface SnapshotDeps { readonly loadElements: (ids: readonly string[]) => Promise<Record<string, ElementDto>>; readonly loadDataProfiles: (ids: readonly string[]) => Promise<Record<string, DataProfileDto>>; readonly env: EnvDto }`
  - `interface SnapshotInput { readonly projectId: string; readonly targetCaseIds: readonly string[]; readonly pin: SnapshotPin }`
  - `MAX_SNAPSHOT_CASES = 200`
  - `buildCompileSnapshot(tx, ctx, input, deps): Promise<CompileSnapshotDto>`
  - `revisionPayloadToAuthoredCase(caseId: string, revisionId: string, payload: RevisionPayload): AuthoredCaseDto`

> **Ranh giới module — đọc kỹ, đây là chỗ dễ vi phạm DAG nhất:**
> - `elements` và `testdata` nằm **trước** authoring trên DAG ⇒ authoring *được phép* gọi facade của chúng. Nhưng hai module đó **chưa tồn tại ở M2** (M4). Vì vậy chúng vào đây dưới dạng **cổng tiêm vào** (`SnapshotDeps.loadElements` / `loadDataProfiles`) — M4 chỉ việc nối facade thật vào, không phải sửa hàm này.
> - `pln_environments` thuộc **planning**, nằm **SAU** authoring trên DAG ⇒ authoring **KHÔNG BAO GIỜ** được import planning. Vì thế `env` là **tham số truyền vào**, do orchestration (phase 0) nạp và đưa xuống. Không có đường nào khác mà không phá DAG.
> - `MAX_SNAPSHOT_CASES = 200` là trần cứng cho việc đóng bao (prereq + step group đệ quy). Compiler đã tự chẩn đoán cycle và depth ≤ 5; trần ở đây chỉ để một case dựng sai không kéo cả bảng vào RAM.

- [ ] **Step 1: Viết test ĐỎ `apps/core/test/authoring/snapshot.test.ts`**

```ts
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import type { DataProfileDto, ElementDto, EnvDto } from "@testkite/contract";
import { compileSnapshotSchema } from "@testkite/contract";
import { withTenant } from "../../src/modules/kernel/index.js";
import { createCase, replaceSteps } from "../../src/modules/authoring/case-service.js";
import { decideReview, promoteCase, submitForReview } from "../../src/modules/authoring/review-service.js";
import { buildCompileSnapshot } from "../../src/modules/authoring/snapshot.js";
import { makeTestDb, type TestDb } from "../harness/pglite.js";

let t: TestDb;
let teamId = "";
let projectId = "";
const alice = { userId: "" };
const bob = { userId: "" };

const ENV: EnvDto = { baseUrl: "https://app.test", vars: { locale: "vi" }, secretNames: ["std_user_password"] };
const DEPS = {
  loadElements: async (): Promise<Record<string, ElementDto>> => ({}),
  loadDataProfiles: async (): Promise<Record<string, DataProfileDto>> => ({}),
  env: ENV,
};

beforeAll(async () => {
  t = await makeTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  const org = await t.db.execute(sql`INSERT INTO organizations (name, slug) VALUES ('Acme','acme') RETURNING id`);
  const orgId = String(org.rows[0]?.["id"]);
  const team = await t.db.execute(sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},'A','a') RETURNING id`);
  teamId = String(team.rows[0]?.["id"]);
  const p = await t.db.execute(sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamId},'P','p') RETURNING id`);
  projectId = String(p.rows[0]?.["id"]);
  const u1 = await t.db.execute(sql`INSERT INTO users (email, display_name) VALUES ('a@x.test','Alice') RETURNING id`);
  const u2 = await t.db.execute(sql`INSERT INTO users (email, display_name) VALUES ('b@x.test','Bob') RETURNING id`);
  alice.userId = String(u1.rows[0]?.["id"]);
  bob.userId = String(u2.rows[0]?.["id"]);
});

const ctx = (): { teamId: string } => ({ teamId });

async function caseWithSteps(name: string, prereqCaseId?: string): Promise<string> {
  const created = await withTenant(t.db, ctx(), (tx) =>
    createCase(tx, ctx(), alice, {
      projectId,
      name,
      isStepGroup: false,
      ...(prereqCaseId === undefined ? {} : { prereqCaseId }),
    }),
  );
  await withTenant(t.db, ctx(), (tx) =>
    replaceSteps(tx, ctx(), alice, {
      caseId: created.id,
      expectedVersion: created.version,
      steps: [
        { kind: "action", renderedSentence: `${name}: open page`, verbOpKey: "goto" },
        {
          kind: "if",
          renderedSentence: `${name}: if ok`,
          conditionExpected: ["SUCCESS"],
          children: [{ kind: "action", renderedSentence: `${name}: click`, verbOpKey: "click" }],
        },
      ],
    }),
  );
  return created.id;
}

describe("buildCompileSnapshot", () => {
  it("sinh snapshot THOẢ compileSnapshotSchema của contract", async () => {
    const caseId = await caseWithSteps("Checkout");
    const snap = await withTenant(t.db, ctx(), (tx) =>
      buildCompileSnapshot(tx, ctx(), { projectId, targetCaseIds: [caseId], pin: "latest" }, DEPS),
    );
    expect(compileSnapshotSchema.safeParse(snap).success).toBe(true);
    expect(snap.teamId).toBe(teamId);
    expect(snap.projectId).toBe(projectId);
    expect(snap.targetCaseIds).toEqual([caseId]);
  });

  it("dựng lại CÂY step từ payload phẳng: `if` có children đúng, ordinal đánh lại từ 1", async () => {
    const caseId = await caseWithSteps("Checkout");
    const snap = await withTenant(t.db, ctx(), (tx) =>
      buildCompileSnapshot(tx, ctx(), { projectId, targetCaseIds: [caseId], pin: "latest" }, DEPS),
    );
    const steps = snap.cases[caseId]?.steps ?? [];
    expect(steps.map((s) => [s.ordinal, s.kind])).toEqual([
      [1, "action"],
      [2, "if"],
    ]);
    const branch = steps[1];
    expect(branch?.kind === "if" ? branch.children.map((c) => [c.ordinal, c.kind]) : []).toEqual([[1, "action"]]);
  });

  it("đóng bao chuỗi prereq — case phụ thuộc có mặt trong `cases` dù không nằm trong target", async () => {
    const loginId = await caseWithSteps("Login");
    const checkoutId = await caseWithSteps("Checkout", loginId);
    const snap = await withTenant(t.db, ctx(), (tx) =>
      buildCompileSnapshot(tx, ctx(), { projectId, targetCaseIds: [checkoutId], pin: "latest" }, DEPS),
    );
    expect(Object.keys(snap.cases).sort()).toEqual([checkoutId, loginId].sort());
    expect(snap.cases[checkoutId]?.prereqCaseId).toBe(loginId);
    expect(snap.targetCaseIds).toEqual([checkoutId]);
  });

  it("pin='ready' đọc BẢN ĐÃ PROMOTE, không phải bản nháp đang sửa", async () => {
    const caseId = await caseWithSteps("Checkout");
    const cur = await t.db.execute(sql`SELECT version FROM aut_cases WHERE id = ${caseId}`);
    const v = Number(cur.rows[0]?.["version"]);
    const submitted = await withTenant(t.db, ctx(), (tx) =>
      submitForReview(tx, ctx(), alice, { caseId, expectedVersion: v }),
    );
    const decided = await withTenant(t.db, ctx(), (tx) =>
      decideReview(tx, ctx(), bob, { caseId, expectedVersion: submitted.version, decision: "approved" }),
    );
    const promoted = await withTenant(t.db, ctx(), (tx) =>
      promoteCase(tx, ctx(), bob, { caseId, expectedVersion: decided.version }),
    );
    // Sau khi promote, Alice sửa tiếp — bản 'ready' KHÔNG được đổi theo.
    await withTenant(t.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), alice, {
        caseId,
        expectedVersion: promoted.version,
        steps: [{ kind: "action", renderedSentence: "BẢN NHÁP MỚI", verbOpKey: "goto" }],
      }),
    );

    const ready = await withTenant(t.db, ctx(), (tx) =>
      buildCompileSnapshot(tx, ctx(), { projectId, targetCaseIds: [caseId], pin: "ready" }, DEPS),
    );
    const latest = await withTenant(t.db, ctx(), (tx) =>
      buildCompileSnapshot(tx, ctx(), { projectId, targetCaseIds: [caseId], pin: "latest" }, DEPS),
    );
    expect(ready.cases[caseId]?.steps.map((s) => s.renderedSentence)).toEqual([
      "Checkout: open page",
      "Checkout: if ok",
    ]);
    expect(latest.cases[caseId]?.steps.map((s) => s.renderedSentence)).toEqual(["BẢN NHÁP MỚI"]);
    expect(ready.cases[caseId]?.revisionId).not.toBe(latest.cases[caseId]?.revisionId);
  });

  it("pin='ready' trên case CHƯA từng promote ⇒ ném lỗi rõ ràng, không âm thầm lấy latest", async () => {
    const caseId = await caseWithSteps("Checkout");
    await expect(
      withTenant(t.db, ctx(), (tx) =>
        buildCompileSnapshot(tx, ctx(), { projectId, targetCaseIds: [caseId], pin: "ready" }, DEPS),
      ),
    ).rejects.toThrow(/chưa có bản ready|ready/i);
  });

  it("gom element id + data profile id rồi gọi ĐÚNG MỘT lần cho mỗi cổng", async () => {
    const caseId = await caseWithSteps("Checkout");
    const calls = { elements: 0, profiles: 0 };
    const snap = await withTenant(t.db, ctx(), (tx) =>
      buildCompileSnapshot(
        tx,
        ctx(),
        { projectId, targetCaseIds: [caseId], pin: "latest" },
        {
          loadElements: async (ids) => {
            calls.elements += 1;
            return Object.fromEntries(
              ids.map((id) => [id, { id, name: id, status: "pending_locator", locators: [] } as const]),
            );
          },
          loadDataProfiles: async () => {
            calls.profiles += 1;
            return {};
          },
          env: ENV,
        },
      ),
    );
    expect(calls).toEqual({ elements: 1, profiles: 1 });
    expect(snap.env).toEqual(ENV);
  });

  it("case của tenant khác trong targetCaseIds ⇒ CaseNotFoundError (404), không rò rỉ", async () => {
    const caseId = await caseWithSteps("Checkout");
    const org = await t.db.execute(sql`SELECT id FROM organizations LIMIT 1`);
    const other = await t.db.execute(
      sql`INSERT INTO teams (org_id,name,slug) VALUES (${String(org.rows[0]?.["id"])},'B','b') RETURNING id`,
    );
    const otherTeamId = String(other.rows[0]?.["id"]);
    const err = await withTenant(t.db, { teamId: otherTeamId }, (tx) =>
      buildCompileSnapshot(
        tx,
        { teamId: otherTeamId },
        { projectId, targetCaseIds: [caseId], pin: "latest" },
        DEPS,
      ),
    ).catch((e: unknown) => e);
    expect((err as { httpStatus?: number }).httpStatus).toBe(404);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm --filter @testkite/core test test/authoring/snapshot.test.ts`
Expected: FAIL — không resolve `snapshot.js`.

- [ ] **Step 3: Implement `apps/core/src/modules/authoring/snapshot.ts`**

```ts
/**
 * Dựng `CompileSnapshot` — đầu vào DUY NHẤT của @testkite/run-compiler.
 * Compiler là hàm THUẦN, không I/O: mọi thứ nó cần phải được fetch sẵn ở đây.
 *
 * RANH GIỚI MODULE (blueprint §4 DAG một chiều):
 *   - elements/testdata đứng TRƯỚC authoring ⇒ được phép gọi, nhưng M2 chưa có
 *     hai module đó nên chúng vào qua CỔNG TIÊM (SnapshotDeps). M4 nối facade thật.
 *   - planning (pln_environments) đứng SAU authoring ⇒ CẤM import. Vì vậy `env` là
 *     THAM SỐ do orchestration (phase 0) nạp và truyền xuống.
 */
import type {
  AuthoredCaseDto,
  AuthoredStepDto,
  CompileSnapshotDto,
  DataProfileDto,
  ElementDto,
  EnvDto,
} from "@testkite/contract";
import type { TenantContext, TkTx } from "../kernel/index.js";
import { CaseRepo } from "./db/case-repo.js";
import { RevisionRepo } from "./db/revision-repo.js";
import { CaseNotFoundError, CaseStateError } from "./errors.js";
import type { RevisionPayload, RevisionStep } from "./revision/payload.js";

export type SnapshotPin = "ready" | "latest";

export interface SnapshotDeps {
  readonly loadElements: (ids: readonly string[]) => Promise<Record<string, ElementDto>>;
  readonly loadDataProfiles: (ids: readonly string[]) => Promise<Record<string, DataProfileDto>>;
  readonly env: EnvDto;
}

export interface SnapshotInput {
  readonly projectId: string;
  readonly targetCaseIds: readonly string[];
  readonly pin: SnapshotPin;
}

/** Trần cứng khi đóng bao prereq + step group. Vượt = dữ liệu sai, không phải case to. */
export const MAX_SNAPSHOT_CASES = 200;

/** Dựng lại CÂY step từ danh sách phẳng (parentId + after) và đánh lại ordinal từ 1. */
function toAuthoredSteps(steps: readonly RevisionStep[], parentId: string | null): AuthoredStepDto[] {
  const siblings = steps.filter((s) => s.parentId === parentId);
  // `after` là danh sách liên kết đơn: bắt đầu từ phần tử có after = null.
  const byAfter = new Map<string | null, RevisionStep>();
  for (const s of siblings) byAfter.set(s.after, s);

  const ordered: RevisionStep[] = [];
  let cursor = byAfter.get(null);
  const guard = siblings.length + 1;
  while (cursor !== undefined && ordered.length < guard) {
    ordered.push(cursor);
    cursor = byAfter.get(cursor.id);
  }
  // Payload hỏng (vòng lặp / mất mắt xích): giữ phần dựng được, nối phần còn lại.
  for (const s of siblings) if (!ordered.includes(s)) ordered.push(s);

  return ordered.map((s, i): AuthoredStepDto => {
    const ordinal = i + 1;
    switch (s.kind) {
      case "action":
        return {
          kind: "action",
          ordinal,
          renderedSentence: s.renderedSentence,
          verbOpKey: s.verbOpKey ?? "",
          ...(s.args === undefined ? {} : { args: s.args }),
          ...(s.elementId === undefined ? {} : { elementId: s.elementId }),
        };
      case "step_group":
        return {
          kind: "step_group",
          ordinal,
          renderedSentence: s.renderedSentence,
          stepGroupCaseId: s.stepGroupCaseId ?? "",
        };
      case "if":
        return {
          kind: "if",
          ordinal,
          renderedSentence: s.renderedSentence,
          conditionExpected: [...(s.conditionExpected ?? [])],
          children: toAuthoredSteps(steps, s.id),
        };
      case "for":
        return {
          kind: "for",
          ordinal,
          renderedSentence: s.renderedSentence,
          loopDataProfileId: s.loop?.dataProfileId ?? "",
          children: toAuthoredSteps(steps, s.id),
        };
      case "while":
        return {
          kind: "while",
          ordinal,
          renderedSentence: s.renderedSentence,
          ...(s.loop?.maxIterations === undefined ? {} : { maxIterations: s.loop.maxIterations }),
          children: toAuthoredSteps(steps, s.id),
        };
      case "rest":
        return {
          kind: "rest",
          ordinal,
          renderedSentence: s.renderedSentence,
          // REST của DB (method/url/headers/body/storeAs) dẹt thành `args` của hợp
          // đồng — headers đi dạng JSON string vì args là Record<string,string>.
          args: {
            ...(s.rest === undefined
              ? {}
              : {
                  method: s.rest.method,
                  url: s.rest.url,
                  ...(s.rest.headers === undefined ? {} : { headers: JSON.stringify(s.rest.headers) }),
                  ...(s.rest.body === undefined ? {} : { body: s.rest.body }),
                  ...(s.rest.storeAs === undefined ? {} : { store: s.rest.storeAs }),
                }),
          },
        };
    }
  });
}

export function revisionPayloadToAuthoredCase(
  caseId: string,
  revisionId: string,
  payload: RevisionPayload,
): AuthoredCaseDto {
  return {
    id: caseId,
    revisionId,
    name: payload.case.name,
    isStepGroup: payload.case.isStepGroup,
    ...(payload.case.prereqCaseId === undefined ? {} : { prereqCaseId: payload.case.prereqCaseId }),
    ...(payload.case.dataProfileId === undefined ? {} : { dataProfileId: payload.case.dataProfileId }),
    steps: toAuthoredSteps(payload.steps, null),
  };
}

export async function buildCompileSnapshot(
  tx: TkTx,
  ctx: TenantContext,
  input: SnapshotInput,
  deps: SnapshotDeps,
): Promise<CompileSnapshotDto> {
  const cases = new CaseRepo(tx, ctx);
  const revisions = new RevisionRepo(tx, ctx);

  const collected: Record<string, AuthoredCaseDto> = {};
  const elementIds = new Set<string>();
  const dataProfileIds = new Set<string>();
  const queue = [...input.targetCaseIds];

  while (queue.length > 0) {
    const caseId = queue.shift();
    if (caseId === undefined || caseId in collected) continue;
    if (Object.keys(collected).length >= MAX_SNAPSHOT_CASES) {
      throw new CaseStateError(
        `Chuỗi case vượt trần ${MAX_SNAPSHOT_CASES} — nghi đồ thị prereq/step group dựng sai`,
      );
    }
    const row = await cases.findById(caseId);
    // RLS đã lọc tenant khác ⇒ 404, không bao giờ 403 (blueprint §3 L3).
    if (row === undefined) throw new CaseNotFoundError(caseId);

    const revisionId = input.pin === "ready" ? row.readyRevisionId : row.latestRevisionId;
    if (revisionId === null) {
      throw new CaseStateError(
        input.pin === "ready"
          ? `Case ${caseId} chưa có bản ready — promote nó trước khi chạy theo lịch/CI`
          : `Case ${caseId} chưa có revision nào`,
      );
    }
    const payload = await revisions.loadPayload(revisionId);
    const authored = revisionPayloadToAuthoredCase(caseId, revisionId, payload);
    collected[caseId] = authored;

    if (authored.prereqCaseId !== undefined) queue.push(authored.prereqCaseId);
    if (authored.dataProfileId !== undefined) dataProfileIds.add(authored.dataProfileId);
    for (const step of payload.steps) {
      if (step.elementId !== undefined) elementIds.add(step.elementId);
      if (step.stepGroupCaseId !== undefined) queue.push(step.stepGroupCaseId);
      if (step.loop?.dataProfileId !== undefined) dataProfileIds.add(step.loop.dataProfileId);
    }
  }

  // Gọi ĐÚNG MỘT lần cho mỗi cổng: N+1 query ở phase 0 là đúng lớp lỗi hệ cũ chết vì nó.
  const elements = await deps.loadElements([...elementIds].sort());
  const dataProfiles = await deps.loadDataProfiles([...dataProfileIds].sort());

  return {
    teamId: ctx.teamId,
    projectId: input.projectId,
    targetCaseIds: [...input.targetCaseIds],
    cases: collected,
    elements,
    dataProfiles,
    env: deps.env,
  };
}
```

- [ ] **Step 4: Mở facade authoring `apps/core/src/modules/authoring/index.ts`**

Thêm vào cuối file (module khác chỉ được import từ đây):

```ts
// Facade công khai của authoring. Orchestration gọi buildCompileSnapshot ở phase 0;
// route/HTTP gọi service; KHÔNG module nào được với tay vào ./db/*.js.
export { createCase, replaceSteps, toCaseSummary, type Actor } from "./case-service.js";
export {
  decideReview,
  promoteCase,
  submitForReview,
  withdrawReview,
  type CaseMutationInput,
  type DecideReviewInput,
} from "./review-service.js";
export {
  buildCompileSnapshot,
  revisionPayloadToAuthoredCase,
  MAX_SNAPSHOT_CASES,
  type SnapshotDeps,
  type SnapshotInput,
  type SnapshotPin,
} from "./snapshot.js";
export { formatETag, parseIfMatch } from "./concurrency.js";
export {
  CaseNotFoundError,
  CaseStateError,
  FourEyesViolationError,
  IfMatchRequiredError,
  VersionConflictError,
} from "./errors.js";
```

- [ ] **Step 5: Chạy test, xác nhận XANH**

Run: `cd testkite && pnpm --filter @testkite/core test test/authoring/snapshot.test.ts`
Expected: PASS 7 test.

- [ ] **Step 6: Verify + commit**

Run: `cd testkite && pnpm typecheck && pnpm lint && pnpm lint:cycles && pnpm test`
Expected: xanh — đặc biệt `lint` (eslint-boundaries) phải xác nhận authoring **không** import planning.

```bash
git add testkite/apps/core/src/modules/authoring/snapshot.ts \
        testkite/apps/core/src/modules/authoring/index.ts \
        testkite/apps/core/test/authoring/snapshot.test.ts
git commit -m "M2-AUT T13: buildCompileSnapshot (pin ready/latest) noi voi run-compiler"
```

---

## Task 14 — Route HTTP vòng đời case ⛔ **CHỜ PLAN IDENTITY**

> **KHÔNG BẮT ĐẦU TASK NÀY** cho tới khi plan identity đã merge đủ hai thứ:
> (a) `buildApp()` trong `apps/core/src/composition-root.ts` trả về một instance Fastify thật;
> (b) middleware auth gắn `request.auth = { teamId, userId, scopes }`.
> Kiểm tra bằng: `grep -n "fastify" testkite/apps/core/src/composition-root.ts` và `grep -rn "auth" testkite/apps/core/src/modules/identity/`. Chưa có ⇒ dừng, làm Task 15 hoặc chờ.
>
> Task 1–13 KHÔNG phụ thuộc gì ở đây và phải hoàn tất trước.

**Files:**
- Create: `apps/core/src/modules/authoring/routes/context.ts`
- Create: `apps/core/src/modules/authoring/routes/cases.ts`
- Create: `apps/core/test/authoring/routes.test.ts`
- Modify: `apps/core/src/modules/authoring/index.ts` (export `authoringRoutes`)
- Modify: `apps/core/src/composition-root.ts` (đăng ký plugin)

**Interfaces:**
- Consumes: `RequestAuth` (identity), `createCase`/`replaceSteps`/`submitForReview`/`withdrawReview`/`decideReview`/`promoteCase`, `parseIfMatch`/`formatETag`, lỗi authoring, `withTenant` + `TkDb` (kernel).
- Produces:
  - `getAuth(request): RequestAuth` — **adapter DUY NHẤT** chạm hình dạng identity
  - `requireScope(auth, scope): void`
  - `authoringRoutes(db: TkDb): FastifyPluginAsync`

**Bảng endpoint (đăng ký với `prefix: "/v1"`):**

| Method | Path | Scope | If-Match | Thành công |
|---|---|---|---|---|
| POST | `/projects/:projectId/cases` | `case:write` | không | 201 + `ETag` + `CaseSummary` |
| GET | `/cases/:caseId` | `case:read` | không | 200 + `ETag` + `CaseSummary` |
| PUT | `/cases/:caseId/steps` | `case:write` | **có** | 200 + `ETag` + `CaseSummary` |
| POST | `/cases/:caseId/submit-review` | `case:write` | **có** | 200 + `ETag` + `CaseSummary` |
| POST | `/cases/:caseId/withdraw-review` | `case:write` | **có** | 200 + `ETag` + `CaseSummary` |
| POST | `/cases/:caseId/review` | `case:review` | **có** | 200 + `ETag` + `CaseSummary` |
| POST | `/cases/:caseId/promote` | `case:promote` | **có** | 200 + `ETag` + `CaseSummary` |

Mã lỗi: 404 `case_not_found` (kể cả id của tenant khác — **không bao giờ 403**), 428 `if_match_required`, 409 `version_conflict` (body = `ThreeWayDiff`), 409 `invalid_case_state`, 403 `four_eyes_self_promote`, 403 `insufficient_scope`.

- [ ] **Step 1: Viết test ĐỎ `apps/core/test/authoring/routes.test.ts`**

```ts
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { authoringRoutes } from "../../src/modules/authoring/index.js";
import { makeTestDb, type TestDb } from "../harness/pglite.js";

let t: TestDb;
let app: FastifyInstance;
let teamId = "";
let projectId = "";
const alice = { userId: "" };
const bob = { userId: "" };
/** Danh tính giả lập của middleware identity — test route, không test auth. */
let current = { teamId: "", userId: "", scopes: [] as string[] };

beforeAll(async () => {
  t = await makeTestDb();
  app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as unknown as { auth: typeof current }).auth = current;
  });
  await app.register(authoringRoutes(t.db), { prefix: "/v1" });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  const org = await t.db.execute(sql`INSERT INTO organizations (name, slug) VALUES ('Acme','acme') RETURNING id`);
  const orgId = String(org.rows[0]?.["id"]);
  const team = await t.db.execute(sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},'A','a') RETURNING id`);
  teamId = String(team.rows[0]?.["id"]);
  const p = await t.db.execute(sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamId},'P','p') RETURNING id`);
  projectId = String(p.rows[0]?.["id"]);
  const u1 = await t.db.execute(sql`INSERT INTO users (email, display_name) VALUES ('a@x.test','Alice') RETURNING id`);
  const u2 = await t.db.execute(sql`INSERT INTO users (email, display_name) VALUES ('b@x.test','Bob') RETURNING id`);
  alice.userId = String(u1.rows[0]?.["id"]);
  bob.userId = String(u2.rows[0]?.["id"]);
  current = {
    teamId,
    userId: alice.userId,
    scopes: ["case:read", "case:write", "case:review", "case:promote"],
  };
});

describe("VÒNG ĐỜI TRỌN VẸN QUA HTTP — exit criteria của M2", () => {
  it("tạo case → sửa steps → submit → review → promote, chỉ dùng HTTP", async () => {
    // 1. tạo
    const created = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/cases`,
      payload: { name: "Checkout", isStepGroup: false },
    });
    expect(created.statusCode).toBe(201);
    const caseId = created.json<{ id: string }>().id;
    expect(created.headers["etag"]).toBe('"1"');

    // 2. sửa steps (If-Match lấy thẳng từ ETag lần trước)
    const edited = await app.inject({
      method: "PUT",
      url: `/v1/cases/${caseId}/steps`,
      headers: { "if-match": String(created.headers["etag"]) },
      payload: { steps: [{ kind: "action", renderedSentence: "open login page", verbOpKey: "goto" }] },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.headers["etag"]).toBe('"2"');

    // 3. submit
    const submitted = await app.inject({
      method: "POST",
      url: `/v1/cases/${caseId}/submit-review`,
      headers: { "if-match": String(edited.headers["etag"]) },
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json<{ status: string }>().status).toBe("in_review");

    // 4. Bob duyệt
    current = { ...current, userId: bob.userId };
    const reviewed = await app.inject({
      method: "POST",
      url: `/v1/cases/${caseId}/review`,
      headers: { "if-match": String(submitted.headers["etag"]) },
      payload: { decision: "approved" },
    });
    expect(reviewed.statusCode).toBe(200);

    // 5. Bob promote (Alice là người sửa cuối nên Bob mới được promote)
    const promoted = await app.inject({
      method: "POST",
      url: `/v1/cases/${caseId}/promote`,
      headers: { "if-match": String(reviewed.headers["etag"]) },
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json<{ status: string; readyRevisionId?: string }>().status).toBe("ready");
    expect(promoted.json<{ readyRevisionId?: string }>().readyRevisionId).toBeDefined();
  });
});

describe("optimistic concurrency qua HTTP", () => {
  async function newCase(): Promise<{ id: string; etag: string }> {
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/cases`,
      payload: { name: "C", isStepGroup: false },
    });
    return { id: res.json<{ id: string }>().id, etag: String(res.headers["etag"]) };
  }

  it("PUT thiếu If-Match ⇒ 428 if_match_required", async () => {
    const c = await newCase();
    const res = await app.inject({
      method: "PUT",
      url: `/v1/cases/${c.id}/steps`,
      payload: { steps: [] },
    });
    expect(res.statusCode).toBe(428);
    expect(res.json<{ code: string }>().code).toBe("if_match_required");
  });

  it("If-Match: * ⇒ 428 (không cho tắt kiểm tra đồng thời)", async () => {
    const c = await newCase();
    const res = await app.inject({
      method: "PUT",
      url: `/v1/cases/${c.id}/steps`,
      headers: { "if-match": "*" },
      payload: { steps: [] },
    });
    expect(res.statusCode).toBe(428);
  });

  it("If-Match lệch ⇒ 409 kèm body ThreeWayDiff đủ ba mốc", async () => {
    const c = await newCase();
    await app.inject({
      method: "PUT",
      url: `/v1/cases/${c.id}/steps`,
      headers: { "if-match": c.etag },
      payload: { steps: [{ kind: "action", renderedSentence: "s1", verbOpKey: "click" }] },
    });
    const stale = await app.inject({
      method: "PUT",
      url: `/v1/cases/${c.id}/steps`,
      headers: { "if-match": c.etag },
      payload: { steps: [{ kind: "action", renderedSentence: "s2", verbOpKey: "click" }] },
    });
    expect(stale.statusCode).toBe(409);
    const body = stale.json<{ code: string; diff: { baseVersion: number; currentVersion: number; mine: unknown[]; theirs: unknown[]; conflicts: string[] } }>();
    expect(body.code).toBe("version_conflict");
    expect(body.diff.baseVersion).toBe(1);
    expect(body.diff.currentVersion).toBe(2);
    expect(body.diff.mine.length).toBeGreaterThan(0);
    expect(body.diff.theirs.length).toBeGreaterThan(0);
  });
});

describe("cách ly tenant + scope", () => {
  it("case của team khác ⇒ 404, KHÔNG BAO GIỜ 403 (blueprint §3 L3)", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/cases`,
      payload: { name: "C", isStepGroup: false },
    });
    const caseId = created.json<{ id: string }>().id;

    const org = await t.db.execute(sql`SELECT id FROM organizations LIMIT 1`);
    const other = await t.db.execute(
      sql`INSERT INTO teams (org_id,name,slug) VALUES (${String(org.rows[0]?.["id"])},'B','b') RETURNING id`,
    );
    current = { ...current, teamId: String(other.rows[0]?.["id"]) };

    const res = await app.inject({ method: "GET", url: `/v1/cases/${caseId}` });
    expect(res.statusCode).toBe(404);
    expect(res.statusCode).not.toBe(403);
  });

  it("thiếu scope ⇒ 403 insufficient_scope", async () => {
    current = { ...current, scopes: ["case:read"] };
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/cases`,
      payload: { name: "C", isStepGroup: false },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe("insufficient_scope");
  });

  it("four-eyes qua HTTP: người sửa cuối tự promote ⇒ 403 four_eyes_self_promote", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/cases`,
      payload: { name: "C", isStepGroup: false },
    });
    const caseId = created.json<{ id: string }>().id;
    const submitted = await app.inject({
      method: "POST",
      url: `/v1/cases/${caseId}/submit-review`,
      headers: { "if-match": String(created.headers["etag"]) },
    });
    current = { ...current, userId: bob.userId };
    const reviewed = await app.inject({
      method: "POST",
      url: `/v1/cases/${caseId}/review`,
      headers: { "if-match": String(submitted.headers["etag"]) },
      payload: { decision: "approved" },
    });
    // Alice là người sửa cuối (cô ấy tạo case) — cô ấy tự promote là vi phạm.
    current = { ...current, userId: alice.userId };
    const res = await app.inject({
      method: "POST",
      url: `/v1/cases/${caseId}/promote`,
      headers: { "if-match": String(reviewed.headers["etag"]) },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe("four_eyes_self_promote");
  });

  it("body sai schema ⇒ 400, không phải 500", async () => {
    const c = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/cases`,
      payload: { name: "C", isStepGroup: false },
    });
    const res = await app.inject({
      method: "PUT",
      url: `/v1/cases/${c.json<{ id: string }>().id}/steps`,
      headers: { "if-match": String(c.headers["etag"]) },
      payload: { steps: [{ kind: "action", renderedSentence: "thiếu verbOpKey" }] },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm --filter @testkite/core test test/authoring/routes.test.ts`
Expected: FAIL — `authoringRoutes` chưa được export.

- [ ] **Step 3: Implement `apps/core/src/modules/authoring/routes/context.ts`**

```ts
/**
 * ĐIỂM CHẠM DUY NHẤT với hình dạng của module identity.
 *
 * Plan identity sở hữu middleware gắn `request.auth`. Nếu nó đặt tên/hình dạng khác
 * (`request.tenant`, `request.principal`, ...) thì SỬA ĐÚNG FILE NÀY — không lan
 * sang service. Đó là toàn bộ lý do file này tồn tại.
 */
import type { FastifyRequest } from "fastify";

export interface RequestAuth {
  readonly teamId: string;
  readonly userId: string;
  readonly scopes: readonly string[];
}

export class InsufficientScopeError extends Error {
  readonly httpStatus = 403;
  readonly code = "insufficient_scope";
  constructor(scope: string) {
    super(`Token thiếu scope ${scope}`);
    this.name = "InsufficientScopeError";
  }
}

export function getAuth(request: FastifyRequest): RequestAuth {
  const auth = (request as unknown as { auth?: RequestAuth }).auth;
  if (auth === undefined || auth.teamId.length === 0 || auth.userId.length === 0) {
    // Không bao giờ xảy ra nếu middleware identity đã chạy — fail loud thay vì
    // âm thầm phục vụ một request không có tenant (L1 fail-closed).
    throw new Error("request.auth vắng mặt — middleware identity chưa được đăng ký trước route authoring");
  }
  return auth;
}

export function requireScope(auth: RequestAuth, scope: string): void {
  if (!auth.scopes.includes(scope)) throw new InsufficientScopeError(scope);
}
```

- [ ] **Step 4: Implement `apps/core/src/modules/authoring/routes/cases.ts`**

```ts
/**
 * Route vòng đời case. Mỗi handler là ba việc, không hơn:
 *   1. auth + scope, 2. parse body/If-Match bằng zod (nguồn hợp đồng),
 *   3. `withTenant(...)` gọi service rồi trả DTO + ETag.
 * Không có logic nghiệp vụ nào ở đây — nó nằm trong service để test được không HTTP.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { reviewDecisionSchema, stepInputSchema } from "@testkite/contract";
import { withTenant, type TkDb } from "../../kernel/index.js";
import { createCase, replaceSteps } from "../case-service.js";
import { decideReview, promoteCase, submitForReview, withdrawReview } from "../review-service.js";
import { formatETag, parseIfMatch } from "../concurrency.js";
import { VersionConflictError } from "../errors.js";
import { getAuth, InsufficientScopeError, requireScope } from "./context.js";

const createBody = z.object({
  name: z.string().min(1),
  isStepGroup: z.boolean().default(false),
  prereqCaseId: z.string().min(1).optional(),
});
const stepsBody = z.object({ steps: z.array(stepInputSchema) });
const reviewBody = z.object({ decision: reviewDecisionSchema, comment: z.string().min(1).optional() });

interface HttpError {
  readonly httpStatus: number;
  readonly code: string;
  readonly message: string;
}

function isHttpError(e: unknown): e is HttpError {
  return typeof e === "object" && e !== null && "httpStatus" in e && "code" in e;
}

export function authoringRoutes(db: TkDb): FastifyPluginAsync {
  return async (app: FastifyInstance): Promise<void> => {
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof VersionConflictError) {
        return reply.code(409).send({ code: error.code, message: error.message, diff: error.diff });
      }
      if (error instanceof InsufficientScopeError || isHttpError(error)) {
        return reply.code(error.httpStatus).send({ code: error.code, message: error.message });
      }
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ code: "invalid_body", message: error.message });
      }
      app.log.error(error);
      return reply.code(500).send({ code: "internal_error", message: "internal error" });
    });

    const send = (reply: FastifyReply, status: number, summary: { version: number }): FastifyReply =>
      reply.code(status).header("etag", formatETag(summary.version)).send(summary);

    app.post<{ Params: { projectId: string } }>("/projects/:projectId/cases", async (request, reply) => {
      const auth = getAuth(request);
      requireScope(auth, "case:write");
      const body = createBody.parse(request.body);
      const summary = await withTenant(db, { teamId: auth.teamId }, (tx) =>
        createCase(tx, { teamId: auth.teamId }, { userId: auth.userId }, {
          projectId: request.params.projectId,
          name: body.name,
          isStepGroup: body.isStepGroup,
          ...(body.prereqCaseId === undefined ? {} : { prereqCaseId: body.prereqCaseId }),
        }),
      );
      return send(reply, 201, summary);
    });

    app.get<{ Params: { caseId: string } }>("/cases/:caseId", async (request, reply) => {
      const auth = getAuth(request);
      requireScope(auth, "case:read");
      const { CaseRepo } = await import("../db/case-repo.js");
      const { CaseNotFoundError } = await import("../errors.js");
      const { toCaseSummary } = await import("../case-service.js");
      const summary = await withTenant(db, { teamId: auth.teamId }, async (tx) => {
        const row = await new CaseRepo(tx, { teamId: auth.teamId }).findById(request.params.caseId);
        if (row === undefined) throw new CaseNotFoundError(request.params.caseId);
        return toCaseSummary(row);
      });
      return send(reply, 200, summary);
    });

    app.put<{ Params: { caseId: string } }>("/cases/:caseId/steps", async (request, reply) => {
      const auth = getAuth(request);
      requireScope(auth, "case:write");
      const expectedVersion = parseIfMatch(request.headers["if-match"]);
      const body = stepsBody.parse(request.body);
      const summary = await withTenant(db, { teamId: auth.teamId }, (tx) =>
        replaceSteps(tx, { teamId: auth.teamId }, { userId: auth.userId }, {
          caseId: request.params.caseId,
          expectedVersion,
          steps: body.steps,
        }),
      );
      return send(reply, 200, summary);
    });

    const mutation = (
      path: string,
      scope: string,
      run: (args: {
        readonly tx: Parameters<Parameters<TkDb["transaction"]>[0]>[0];
        readonly teamId: string;
        readonly userId: string;
        readonly caseId: string;
        readonly expectedVersion: number;
        readonly body: unknown;
      }) => Promise<{ version: number }>,
    ): void => {
      app.post<{ Params: { caseId: string } }>(path, async (request, reply) => {
        const auth = getAuth(request);
        requireScope(auth, scope);
        const expectedVersion = parseIfMatch(request.headers["if-match"]);
        const summary = await withTenant(db, { teamId: auth.teamId }, (tx) =>
          run({
            tx,
            teamId: auth.teamId,
            userId: auth.userId,
            caseId: request.params.caseId,
            expectedVersion,
            body: request.body,
          }),
        );
        return send(reply, 200, summary);
      });
    };

    mutation("/cases/:caseId/submit-review", "case:write", ({ tx, teamId, userId, caseId, expectedVersion }) =>
      submitForReview(tx, { teamId }, { userId }, { caseId, expectedVersion }),
    );
    mutation("/cases/:caseId/withdraw-review", "case:write", ({ tx, teamId, userId, caseId, expectedVersion }) =>
      withdrawReview(tx, { teamId }, { userId }, { caseId, expectedVersion }),
    );
    mutation("/cases/:caseId/review", "case:review", ({ tx, teamId, userId, caseId, expectedVersion, body }) => {
      const parsed = reviewBody.parse(body);
      return decideReview(tx, { teamId }, { userId }, {
        caseId,
        expectedVersion,
        decision: parsed.decision,
        ...(parsed.comment === undefined ? {} : { comment: parsed.comment }),
      });
    });
    mutation("/cases/:caseId/promote", "case:promote", ({ tx, teamId, userId, caseId, expectedVersion }) =>
      promoteCase(tx, { teamId }, { userId }, { caseId, expectedVersion }),
    );
  };
}
```

> `await import(...)` trong handler GET là **tạm bợ có chủ đích** để tránh vòng import khi facade còn đang được dựng. Nếu `pnpm lint:cycles` (madge) xanh với import tĩnh thì **chuyển sang import tĩnh ở đầu file** — dynamic import trong hot path là chi phí không cần thiết.

- [ ] **Step 5: Đăng ký plugin + export facade**

`apps/core/src/modules/authoring/index.ts` — thêm:

```ts
export { authoringRoutes } from "./routes/cases.js";
export { getAuth, requireScope, InsufficientScopeError, type RequestAuth } from "./routes/context.js";
```

`apps/core/src/composition-root.ts` — trong `buildApp()`, sau khi identity đã đăng ký middleware auth, thêm (giữ đúng thứ tự DAG: identity trước, authoring sau):

```ts
  await app.register(authoringRoutes(db), { prefix: "/v1" });
```

- [ ] **Step 6: Cài `fastify` nếu identity chưa cài**

Run: `cd testkite && pnpm --filter @testkite/core add fastify@^5.2.0` (bỏ qua nếu plan identity đã thêm — kiểm tra `apps/core/package.json` trước).

- [ ] **Step 7: Chạy test, xác nhận XANH**

Run: `cd testkite && pnpm --filter @testkite/core test test/authoring/routes.test.ts`
Expected: PASS 8 test — trong đó test "VÒNG ĐỜI TRỌN VẸN QUA HTTP" chính là **exit criteria của M2**.

- [ ] **Step 8: Verify + commit**

Run: `cd testkite && pnpm typecheck && pnpm lint && pnpm lint:cycles && pnpm test && pnpm openapi:check`

```bash
git add testkite/apps/core/src/modules/authoring/routes/ \
        testkite/apps/core/src/modules/authoring/index.ts \
        testkite/apps/core/src/composition-root.ts \
        testkite/apps/core/test/authoring/routes.test.ts \
        testkite/apps/core/package.json testkite/pnpm-lock.yaml
git commit -m "M2-AUT T14: route vong doi case (tao/sua/submit/review/promote) qua HTTP"
```

---

## Task 15 — Tick backlog M2

- [ ] **Step 1: Tick các dòng authoring trong `testkite/tasks/M2-identity-authoring.md`**

```
- [x] Authoring: aut_cases (5 timestamp workflow đủ) / aut_steps / aut_step_loops / aut_rest_steps
      + revisions (zstd append-only) + reviews + advisory locks (hash: <T2,T3,T4,T10,T11>)
- [x] Four-eyes: người-sửa-cuối-không-tự-promote (trừ teams.allow_self_promote) (hash: <T11>)
- [x] Optimistic concurrency: version + ETag/If-Match (428 nếu thiếu), 409 kèm diff 3 chiều (hash: <T6,T7,T9>)
```

Chỉ tick dòng **Exit** (`tạo case → sửa → review → promote chạy trọn qua API`) khi Task 14 đã xanh; phần `bộ T4 cách ly tenant xanh trên CI` thuộc plan identity, KHÔNG tick từ đây.

- [ ] **Step 2: Commit**

```bash
git add testkite/tasks/M2-identity-authoring.md
git commit -m "M2-AUT T15: tick backlog authoring"
```

---

## Self-Review

**1. Spec coverage**

| Yêu cầu (spec / backlog) | Task |
|---|---|
| `aut_cases` đủ **5 timestamp workflow** (created/updated/submitted/reviewed/promoted) | Task 2 |
| `aut_cases` giữ `is_step_group` một-bảng | có từ M1 T5, giữ nguyên (Task 2 không đụng) |
| `aut_steps` — 6 kind khớp `STEP_KINDS` của contract | Task 3 |
| `aut_step_loops` 1:1 (hậu duệ `for_step_conditions`) | Task 3 |
| `aut_rest_steps` | Task 3 |
| `aut_case_revisions` — snapshot **zstd append-only** | Task 1 (codec) + Task 4 (bảng + GRANT chỉ SELECT/INSERT) |
| Reviews | Task 10 |
| **Advisory locks** | Task 11 (lấy khoá) + Task 12 (chứng minh trên PG thật) |
| **Four-eyes**: người-sửa-cuối-không-tự-promote, trừ `teams.allow_self_promote` | Task 2 (cột) + Task 11 (luật) |
| **Optimistic concurrency**: `version` + ETag/If-Match, thiếu ⇒ **428** | Task 2 (cột) + Task 7 (parse/format) + Task 9/10/11 (áp dụng) |
| Lệch ⇒ **409 kèm diff 3 chiều** base/mine/theirs | Task 5 (DTO) + Task 6 (thuật toán) + Task 9 (dựng lỗi) |
| RLS + composite FK theo pattern M1 cho MỌI bảng mới | Task 3, 4, 10 (mỗi bảng: `UNIQUE(team_id,id)`, index dẫn đầu `team_id`, composite FK, `pgPolicy` + `.enableRLS()`) |
| Migration + GRANT **viết tay** theo pattern 0002/0004/0006 | Task 3 (`*_aut_steps_grants`), Task 4 (`*_aut_case_revisions_grants`), Task 10 (`*_aut_case_reviews_grants`) |
| Cross-tenant ⇒ **404, không bao giờ 403** | Task 7 (`CaseNotFoundError`), Task 9 (test), Task 13 (test), Task 14 (test HTTP) |
| API vòng đời: tạo → sửa → submit → review → promote qua HTTP (**exit M2**) | Task 14 |
| `CompileSnapshot` sinh từ authoring DB (case + steps + elements + data + env) | Task 13 |
| Ghim revision: schedule/CI = `ready`, ad-hoc = `latest` (§4 phase 1) | Task 13 (`pin`), Task 11 (`ready_revision_id`), Task 9 (sửa case ready giữ ghim) |
| SPIKE zstd native Node 22 + đo trên payload thật | mục "Kết quả spike" §1 (đã chạy) |
| SPIKE diff 3 chiều: tự viết hay dùng lib | mục "Kết quả spike" §2 (đã chạy `pnpm info` + đo nhiễu thật) |

**2. Ngoài phạm vi CÓ CHỦ ĐÍCH (không phải thiếu sót)**

- Identity/RBAC/token/audit, bootstrap Fastify, middleware auth, bộ CI cross-tenant T4 sinh từ OpenAPI, onboarding team 1-transaction → **plan identity** (song song).
- `aut_steps.subscription_id` (XOR `step_group_case_id`), `published_step_groups`, `step_group_subscriptions` → phần **sharing**, M5.
- FK thật cho `element_id` → `elm_elements` và `loop_data_profile_id` → `tdt_profiles` → **M4** (bảng chưa tồn tại). Cột đã đúng kiểu `uuid`, chỉ thiếu ràng buộc.
- `loadElements`/`loadDataProfiles` bản thật (facade elements/testdata) → **M4**; M2 để chúng ở dạng cổng tiêm.
- `aut_tags`, `aut_priorities`, `aut_types` → chưa cần cho vòng đời, để sau.
- Phase 0 fetch của orchestration (ai gọi `buildCompileSnapshot`) → **M3**; M2 chỉ chốt *hình dạng* snapshot.
- Advisory lock "hiện diện TTL 60s" (§4, khoá soạn thảo hiển thị cho UI) khác với advisory lock promote ở đây — thuộc UI M3/M4.

**3. Quét placeholder**

Không có "TBD" / "implement later" / "tương tự Task N" / "thêm xử lý lỗi phù hợp". Mọi step có code là code chạy được; mọi step có lệnh đều kèm kết quả mong đợi. Hai chỗ **cố ý** để lại chỉ dẫn thay vì code chết: (a) `void row` thừa trong `buildRevisionPayload` — Task 8 nói rõ phải xoá và vì sao không được sắp lại; (b) `await import(...)` trong route GET — Task 14 nói rõ khi nào chuyển sang import tĩnh.

**4. Nhất quán kiểu / tên**

- `TkDb`/`TkTx`/`TenantContext`/`TenantRepo`/`withTenant` — lấy từ facade kernel, tên y hệt M1.
- `RevisionPayload`/`RevisionStep` khai ở Task 6, dùng nguyên ở Task 8, 9, 13.
- `StepRow`/`LoopRow`/`RestRow` khai ở Task 8, dùng ở `CaseRepo` (Task 9).
- `CaseSummaryDto` khai ở Task 5, là kiểu trả của **mọi** service (Task 9, 10, 11) và mọi route (Task 14).
- `ThreeWayDiffDto`/`CaseChangeDto` khai ở Task 5, sinh ở Task 6, mang trong `VersionConflictError` (Task 7), trả ở body 409 (Task 14).
- `Actor` khai ở Task 9 (`case-service.ts`), import lại ở Task 10/11 (`review-service.ts`).
- `CaseMutationInput` khai ở Task 10, dùng lại nguyên si cho `promoteCase` (Task 11).
- `conflictFor()` khai ở Task 10, dùng ở `submitForReview`/`withdrawReview`/`decideReview` (Task 10) và `promoteCase` (Task 11).
- Vị từ RLS `NULLIF(current_setting('app.team_id', true), '')::uuid` viết y hệt ở Task 3, 4, 10 — cùng chuỗi với M1.
- Tên enum: `aut_case_status` (Task 2), `aut_step_kind` (Task 3), `aut_review_state` (Task 10) — không trùng nhau, không trùng `membership_role`/`team_status` của identity.

**5. Rủi ro đã biết + đối sách nằm sẵn trong plan**

| Rủi ro | Đối sách |
|---|---|
| Node < 22.15 không có zstd ⇒ lỗi khó hiểu lúc chạy | `engines.node >= 22.15.0` (Task 1 Step 1) + `assertZstd()` ném thông điệp chỉ thẳng nguyên nhân |
| Payload nhỏ phình ra khi nén | nhánh `codec='raw'` + test riêng (Task 1) |
| PGlite trả `bytea` là `Uint8Array`, PG thật trả `Buffer` | `decodeRevision` nhận `Uint8Array`; `bytea` customType luôn `Buffer.from` (Task 1, 4) + test khẳng định |
| drizzle 0.45.2 không có `bytea` | tự khai `customType` (Task 4), đã kiểm chứng thiếu bằng spike |
| drizzle-kit có thể không sinh `WHERE` của partial index | Task 10 Step 4 buộc kiểm mắt + đường lui đưa câu `CREATE UNIQUE INDEX ... WHERE` sang file grants |
| Hai submit song song tạo hai review mở | partial unique index ở DB, không dựa vào service (Task 10) |
| Hai promote song song | advisory lock lấy **trước** mọi đọc (Task 11) + bằng chứng tranh chấp thật (Task 12) |
| Advisory lock chứng minh giả trên PGlite | Task 12 chạy trên Postgres thật, `skipIf` khi không có `TESTKITE_TEST_PG_URL`; CI PG17 luôn chạy |
| Diff báo "đổi toàn bộ case" mỗi lần lưu | id step ổn định + `after` thay ordinal (Task 6, 8), có test đo đúng số mục |
| Client gửi id step của case/tenant khác | `existingIds` chỉ lấy từ chính case đó (Task 8), có test |
| Số thứ tự migration đụng plan identity | mục "Phụ thuộc chéo" §3: tham chiếu theo **tag**, rebase thì regen + đổi tên file grants + sửa `_journal.json` |
| Sửa case `ready` làm hỏng lịch đêm đang chạy | `applyEdit` về `draft` nhưng **giữ** `ready_revision_id`; `pin='ready'` vẫn đọc bản cũ (Task 9, 13) có test |
| Authoring lỡ import planning để lấy env | `env` là tham số của `buildCompileSnapshot`; `pnpm lint` (eslint-boundaries) là cổng (Task 13 Step 6) |
| Thêm schema OpenAPI làm vỡ gate drift byte | Task 5 Step 4 bắt buộc thêm vào **cuối** `OPENAPI_SCHEMA_NAMES` và cuối `components.schemas`, rồi `pnpm openapi:check` |
| Task 14 bị chặn bởi identity | Task 1–13 độc lập hoàn toàn; Task 14 có điều kiện kiểm tra cụ thể ở đầu task, và `routes/context.ts` cô lập mọi giả định về identity vào một file |
