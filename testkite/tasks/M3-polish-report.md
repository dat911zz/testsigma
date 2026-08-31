# M3 — Báo cáo Polish wave (31-08-2026)

> Nghi thức: CLAUDE.md Luật 2, dòng "Cuối mỗi milestone". Báo cáo này chốt phần *phân loại +
> bằng chứng*; nó **không** tự tuyên bố M3 nghiệm thu — mục 5 nói rõ cái gì còn nợ.

## 1. Phạm vi

**Đầu vào:** 95 nit gặt được từ **7 wave review của M3** (T1–T16 control plane + T1–T20 fleet)
cộng **3 lượt rà soát chéo** chạy sau khi implement xong:

- **An ninh end-to-end** — đi dọc đường credential (bootstrap `tkb_` → worker `tkw_` → run `tkr_`),
  đường fence (lease/epoch), và đường ra object store.
- **Đơn giản hoá / nhất quán** — trùng lặp, hằng số song trùng hai phía biên, pattern lệch nhau
  giữa module.
- **Chất lượng test** — test xanh mà không chứng minh gì, test khẳng định đại lượng nó không điều
  khiển, test chạy trên nền không có tranh chấp thật.

**Cây file trong phạm vi:** `testkite/apps/core/src/modules/orchestration`, `.../results`,
`src/http/internal`, `testkite/apps/runner/**`, `testkite/packages/contract/src/routes/internal.ts`,
`.github/workflows/testkite-ci.yml`, `testkite/scripts/**`.

**Điểm xuất phát (trước polish, hash `3341d1f`):** 1250 test xanh — apps/core 670, apps/runner 275,
run-compiler 179, contract 84, verb-kit 12, tools 30; lint / lint:cycles / openapi:check sạch.

## 2. Bảng phân loại

Quy tắc đếm: đơn vị là **nit** (một khiếm khuyết được nêu), không phải một dòng review. Nhiều nit
đã bị hấp thụ ngay trong dòng chảy M3 — mỗi task có review chặn thì có một commit `review fixes`
riêng — nên polish wave chỉ gặt phần **chưa ai đụng tới**.

| Phân loại | Số nit | Ghi chú |
|---|---:|---|
| **Áp** — trong dòng chảy M3 (12 commit `review fixes` + `c0c2f42`) | 65 | Số **phần dư** (95 − 14 − 13 − 3), không đếm tay từng dòng. Commit: `629a372` `062aad2` `8b08b68` `b873258` `91ce28d` `cfca282` `80c47fc` `0ba1d18` (ORC T3/T6/T8/T9/T11/T13/T14/T16) · `be6cfd0` `1eb21bd` `96a38ab` `c469779` (FLT T11/T12/T15/T17) |
| **Áp** — trong polish wave (3 lô, mục 3) | 14 | `e4d2028` (4) · `c532778` (5) · `95f1c26` (5) |
| **Bỏ** | 13 | 7 nhóm lý do, liệt kê dưới |
| **Hoãn** | 3 | 3 mục, mỗi mục có địa chỉ milestone/điều kiện (NIT 1+14 ban đầu xếp hoãn, kiểm lại thấy `c0c2f42` đã sửa — xem 2.2) |
| **Tổng** | **95** | |

### 2.1. Nhóm BỎ — lý do đại diện từng nhóm

1. **An ninh #4 — siết endpoint `register`** (từ chối upsert khi hostname khác, rate-limit đăng ký,
   bootstrap token theo từng host). *Bỏ vì:* bootstrap token per-host là **thay đổi thiết kế định
   danh fleet** ⇒ M4+; còn heuristic "hostname khác thì 401" có thể chặn chính đáng việc re-register
   sau khi đổi tên host — không phải fix gọn.
2. **An ninh #5 — đối chiếu `steps[].caseId`/`screenshotArtifactId` với plan đã đóng băng + FK cho
   `res_case_results`.** *Bỏ vì:* đòi gọi `readRunPlan` trên đường `complete` (hiện chỉ có ở đường
   claim) **cộng** một migration FK mới ⇒ là thay đổi thiết kế, không phải nit. Hoãn sang M4 kèm
   plan riêng.
3. **Đơn giản hoá — gộp 4 bản `toDate` vào `kernel/db/rows.ts`.** *Bỏ vì:* pure refactor, hành vi
   runtime y hệt, **không test nào đỏ được trước/sau** ⇒ thuần nhất quán; xếp dưới hai fix an ninh
   trong hạn mức khối lượng của đợt.
4. **Đơn giản hoá — hoist `OOM_QUARANTINE_THRESHOLD` sang `packages/contract`.** *Bỏ vì:* buộc cả 3
   lô cùng đụng `queue/job-queue.ts` + `memory-governance.ts` + `contract/internal.ts` ⇒ vi phạm
   đúng luật "các lô không đụng cùng file"; drift hiện mới chỉ là **giả định** (cả hai đang là 2).
5. **NIT 8 + 17 + 19 + 23 + 24 + 36 + 38 + 58 — bổ sung comment một dòng còn THIẾU** (`quota.ts`,
   `job-queue.ts`, `reaper.ts`, `loop.ts`, `routes.ts`, `context-monitor.test.ts`). *Bỏ vì:* không
   phát biểu nào **SAI**, chỉ **vắng mặt**; không có cách chứng minh bằng test (yêu cầu bắt buộc của
   mỗi item trong đợt này), và sẽ trải thêm 5 file vào chính lô đang mang 2 fix an ninh.
6. **Mọi hạng mục cần host thật / pilot.** *Bỏ khỏi đợt này vì môi trường không đo được:* systemd
   **áp dụng** được unit (CI không boot fleet, và `systemd-analyze verify` trả **exit 0 kể cả khi
   in lỗi**); object store thật trả 403 cho PUT sai `content-length`; đọc `/proc/pressure/memory`
   (**không tồn tại** trong môi trường này). Đây là rổ bằng chứng chuyển sang host pilot, không phải
   nit bị vứt.
7. **Chạy `test/host` (chromium có sandbox) trong job CI mặc định.** *Bỏ vì:* môi trường này chạy
   **uid 0** ⇒ Chromium từ chối sandbox và playwright tự thêm `--no-sandbox` (nó chỉ **không** thêm
   khi `chromiumSandbox === true`). Chỉ nghiệm thu được ở **job nightly non-root** — đã nối dây ở
   Lô 3 item 5.

### 2.2. Nhóm HOÃN — nợ kỹ thuật CÓ ĐỊA CHỈ

| # | Nội dung | Vì sao hoãn | Hoãn tới đâu |
|---|---|---|---|
| **NIT 1 + 14** ~~HOÃN~~ → **ĐÃ LỖI THỜI, KHÔNG CÒN NỢ** | `test/concurrency/relay-race.test.ts` đỏ **1/2 lần** ở review T1 và **1/3 lần** ở review T5, chữ ký `expected 20 to be 21` — đúng là một **bản sao publish thật**, không phải chậm vì tranh CPU. | Triage đọc đúng triệu chứng nhưng bỏ sót mốc thời gian: cả hai lần đỏ đó đều xảy ra **TRƯỚC** commit `c0c2f42` (land ngay sau `9e33aa1` = T5, trước `23d5378` = T6), tức chúng là triệu chứng của chính cái lỗi mà `c0c2f42` sửa: `WHERE … NOT EXISTS … FOR UPDATE SKIP LOCKED` gộp một câu lấy snapshot lúc bắt đầu câu lệnh nhưng chỉ khoá hàng SAU khi đã ước lượng vị từ, nên commit của relay đối thủ vô hình ⇒ publish đôi. Fix: khoá hàng trước, kiểm `consumed` ở câu lệnh RIÊNG. | **Không hoãn nữa.** Nghiệm thu lại 31-08 sau polish: 8 lượt liên tiếp trên PG thật (cụm riêng cổng 55433) = 8×5/5 xanh, cộng 5 lượt lúc T6 và mọi lần chạy full suite từ đó. Nếu file này đỏ lại thì mở ticket mới với chữ ký quan sát được, đừng trích lại dòng này. |
| **NIT 4** | Không migration nào cấp thành viên (`GRANT testkite_dispatch TO <login role thật>`) cho `testkite_app` / `testkite_auth` / `testkite_relay` / `testkite_dispatch`; việc login role production được nạp vào các sub-role này nằm **hoàn toàn ngoài repo**. | Khoảng trống có từ M1/M2, **không do M3 tạo**. Đây là quyết định hạ tầng/ops (ai là login role, cấp bằng công cụ nào) chứ không phải code. Cấp nhầm `testkite_dispatch` cho cùng login đang giữ `testkite_app` sẽ **tái tạo đúng lỗ hổng OR-qua-kế-thừa** mà spike 2026-08-29 đã cảnh báo. | **Backlog hạ tầng — phải chốt TRƯỚC lần deploy production đầu tiên (runbook M9)**, kèm một kiểm tra khẳng định không login role nào giữ đồng thời `testkite_app` và `testkite_dispatch`. |
| **NIT 12** ~~HOÃN~~ → **ĐÃ TRẢ** | `toCompileSnapshot` / `toAuthoredCase` / `toAuthoredStep` trong `run-service.ts` là bản sao DTO↔domain duy trì **bằng tay**. Switch theo step-kind thì exhaustive (TS bắt được kind mới), nhưng **không có gì bắt được một optional field mới bị âm thầm rơi mất** khi rebuild. | Chưa phải khiếm khuyết hôm nay, nhưng hàng rào **đúng** là một guard **cấp KIỂU** — thiết kế guard đó là một task nhỏ riêng, không phải một dòng sửa. | **ĐÃ TRẢ — commit `81e8c06`** (plan `plans/2026-08-31-m3-debt.md` Task D2). `FieldMap<Src, Dst>` (type-only, `packages/contract/src/schemas/field-map.ts`) buộc **mọi** field của DTO — optional cũng thế — phải có mặt trong bảng, và giá trị là **khoá đích** nên TS kiểm luôn đích có thật. Áp cho 5 adapter / 10 bảng: `ADAPTER_FIELD_MAPS` (run-service), `STEP_RESULT_FIELDS` (internal/routes), `COMPLETED_STEP_FIELDS` (worker). Guard được chứng minh **không rỗng** bằng `ts.createProgram` chạy lên 6 fixture đỏ có chủ đích (TS1360 nêu đích danh tên field · TS2322 · TS2353, cộng negative control trả `[]`). **Phạm vi kiểu KHÔNG với tới:** nó chứng minh field được NHÌN, không chứng minh thân hàm CHÉP — nên tập entry `null` bị pin bằng test tầng 2 **theo từng app** (`apps/core/test/arch/adapter-guard.test.ts` + `apps/runner/test/arch/field-map-drops.test.ts`; hai test chứ không một, vì hai app ngang hàng không resolve được nhau), cộng `tools/field-map-inventory.test.ts` chặn bảng thứ tư ra đời ở chỗ không ai canh. **KHÔNG áp** cho `authoring/snapshot.ts` (nguồn là hàng DB `RevisionStep`, 5/13 entry sẽ phải là `null` vì lý do không phải drop) và `results-service.ts` (nguồn là `Record<string, unknown>`). |
| **NIT 73** ~~HOÃN~~ → **ĐÃ TRẢ** | `StepOutcome` không có trường phân biệt **vòng lặp / hàng dữ liệu**, nên N lần chạy thân một `for` đều mang chung `(caseId, ordinal)`. Hệ quả cụ thể ở đường đọc: `latestStepResults` (`results-service.ts`) dùng `SELECT DISTINCT ON (step_ordinal) …` ⇒ một `for` 3 hàng dữ liệu chỉ hiện **MỘT** dòng trong report; hai hàng kia bị nuốt. | Có thật và là **mất dữ liệu ở tầng báo cáo**, nhưng sửa đúng đòi **thay đổi hợp đồng** `StepOutcome` (thêm trường phân biệt) **cộng** đổi luật đọc `DISTINCT ON` — hai phía biên, không phải một nit. | **ĐÃ TRẢ — commit `7864932`** (plan `plans/2026-08-31-m3-debt.md` Task D1). `execSeq` (khoá + thứ tự) và `loopPath` (nhãn) đi trọn tuyến runner → contract → core → DB → đường đọc; bất biến chuyển sang đường ghi bằng `res_step_results_exec_unique` (migration 0043), `DISTINCT ON` bị bỏ. **Phát hiện rộng hơn báo cáo này mô tả:** nuốt hàng KHÔNG phải bệnh riêng của `for` — step group inline lặp lại chính ordinal của group nên một case đã có ordinal trùng (1, 2, 3, 2) mà không cần vòng lặp nào, và cùng cái ordinal trùng ấy làm `sentenceIndex` trong `worker.ts` gán SAI câu NLP cho step (đã xoá). **Phần KHÔNG sửa:** fan-out cấp CASE vẫn gộp N lần chạy về một `res_case_results` — không step nào biến mất, nhưng độ mịn cấp case đòi đổi PRIMARY KEY `res_case_result_keys`, địa chỉ **M4** (đã ghi vào `M4-elements-verbs-planning.md`). |

## 3. Các lô fix đã áp trong polish wave

Ba lô, không lô nào đụng file của lô khác. Mỗi item có test **ĐỎ trước khi sửa**.

### Lô 1 — `e4d2028` · Vòng đời credential + trần object-store (control plane)

*Chứng minh: một credential có TTL mà không có đường gia hạn thì TTL đó đo sai đại lượng; và một
trần chỉ được thực thi nếu nó nằm TRONG chữ ký.*

1. **`renewRunTokenTtl`** — run token trước đây đóng dấu `expires_at` **một lần** lúc claim
   (`lease_expires_at` + 30 + 60s), trong khi lease được gia hạn ở mọi heartbeat và ngân sách chain
   lên tới 900s ⇒ worker vẫn là chủ hợp lệ nhưng mọi lời gọi sau 90s trả **401**. Nay gia hạn trong
   **cùng transaction `withTenant`** với `heartbeatJob`, hàng rào `lease_epoch` + `revoked_at IS NULL`
   (worker bị fence không tự gia hạn được, token đã revoke không sống lại). ĐỎ trước: heartbeat thứ 2
   của chuỗi 180s trả 401.
2. **Chữ ký presign ràng buộc kích thước** — `PresignInput` thành union theo method: PUT **bắt buộc**
   `contentLength`/`contentType`, GET giữ `host` một mình (nhờ vậy test vector AWS còn khớp nguyên
   vẹn). `assertSendable` chặn `body.length !== signedContentLength` **trước** khi PUT. **TRUNG
   THỰC:** CI không có object store thật ⇒ test chỉ chứng minh chữ ký **CÓ** ràng buộc (pin nguyên
   văn `canonicalRequest` bằng một phép tính SigV4 độc lập); hành vi 403 đầu kia là bằng chứng
   host-pilot.
3. **Ba tuyên bố SAI trong chính các file trên** — `uploader.ts` "the signature covers that header"
   (chỉ đúng SAU item 2), `artifacts.ts` "refuses to SIGN … an unchecked size", và docstring
   `revokeRunTokensFor` ghi "reap, cancel, complete" trong khi call-site production **DUY NHẤT** là
   nhánh infra-requeue của `internalComplete`. Một test tripwire quét `apps/core/src` và khẳng định
   đúng một call-site.
4. **Migration 0042** — `job_runs_lease_idx` đổi cột dẫn đầu sang `heartbeat_at` (cả hai câu lọc của
   reaper đều đọc `heartbeat_at`, không câu nào đọc `lease_expires_at` — cột đắt hơn **và** vô dụng);
   DROP `usage_counters_team_idx` trùng byte-for-byte index của PK; **PARTIAL** unique
   `orc_run_tokens_live_uidx … WHERE revoked_at IS NULL` (partial là bắt buộc: revoke là bia mộ chứ
   không xoá, unique toàn phần sẽ chặn re-mint hợp lệ). `pnpm db:generate` sau đó: *"No schema
   changes, nothing to migrate"*.

**Verify:** 1269 test (core 687, runner 277, run-compiler 179, contract 84, verb-kit 12, tools 30).

### Lô 2 — `c532778` · Fleet: fence thật, guard thật, lỗi không bị nuốt (`apps/runner`)

*Chứng minh: một lỗi bị nuốt ở tầng đọc số biến một sự cố thật thành báo cáo "khoẻ mạnh".*

1. **`#onJobSignal`: 401 vào nhánh fence** như 409/410. Trước đây worker **mất credential vẫn lái
   browser thật** trên hệ thống tenant tới hết ngân sách chain (900s) trong khi lease đã bị reap và
   attempt khác chạy song song ⇒ side-effect trùng lặp.
2. **`run-chain.ts`: bỏ clamp `Math.max(chainMs, budget.stepMs + 1)`** trong `assertNested` — guard
   chạy trên đúng giá trị truyền xuống engine. Ca test "closes the context in finally even when the
   chain times out" đổi từ `timeoutSeconds: 0` (lợi dụng kẽ hở) sang 180s + fake timers.
3. **`memory/rss.ts`: chỉ nuốt ENOENT/ESRCH**; mọi errno khác **NÉM** để `sumRssBytes` không âm thầm
   undercount qua `?? 0` ⇒ trần L2/L3 không bao giờ nổ. Siết parse sang `/^\d+$/` (trước đây
   `parseInt` đọc `'21700abc'` thành 21700).
4. **`MemorySnapshot.unreadable` mang lý do** khi một file cgroup không đọc được (phân biệt ENOENT —
   cgroup bị gỡ, hợp lệ — với EACCES/EISDIR/EIO). Trước đây `#readText` nuốt mọi lỗi thành chuỗi rỗng
   ⇒ `0 current, 0 oom_kill` ⇒ **một OOM THẬT báo cáo là chain khoẻ mạnh**.
5. **Dọn tuyên bố sai:** xoá `it("NEVER passes --no-sandbox anywhere in the deploy tree")` (grep 3
   file config viết tay tìm một chuỗi mà **không cơ chế nào ghi vào đó**; argv thật do playwright-core
   sinh lúc runtime); bỏ mệnh đề sai "manifest generated from MEMORY.recycle".

**KHÔNG áp (có lý do đo được):** chèn `void work.catch()` vào `raceDeadline` — `Promise.race` đã gắn
handler lên `work`, nên reject muộn của bên thua **không bao giờ** thành unhandled rejection (đo bằng
node trần **và** bằng test mới, XANH trên source chưa sửa). Thêm test làm hàng rào cho bất biến đó
thay vì thêm một dòng thừa.

**Verify:** 1286 test (core 687, runner 294, …).

### Lô 3 — `95f1c26` · Bịt lỗ gate máy + khoá trôi dạt hợp đồng (CI/config/contract)

*Chứng minh: năm lỗ hổng có chung một hình dạng — **một cái gate xanh mà không đo gì cả**.*

1. **Hai gate browser trong CI neo tên driver ngay sau dấu nháy** ⇒
   `import test from "@playwright/test"` (có scope đứng trước) **đi lọt**; đo thực nghiệm: pattern cũ
   khớp 1/3 dạng xấu. Thay bằng pattern nhận cả scope + thêm **NEGATIVE CONTROL** chạy trước khi quét
   cây thật (đòi đúng 3 hit trên mẫu 5 dòng) ⇒ bắt được cả gate mù lẫn gate đỏ vĩnh viễn. So sánh
   dùng `!=` chứ không `-ne`: regex hỏng làm grep trả stdout **RỖNG**, và `[ "" -ne 3 ]` tự lỗi — một
   `if` đọc lỗi là "sai" ⇒ self-check in ra "đạt". Thêm `apps/runner/deploy` vào gate ngôn ngữ.
2. **`db-tests` đặt `TESTKITE_REQUIRE_PG=1`**, quyết định chạy/skip tách thành hàm thuần
   `resolveRealPgMode`. Thiếu URL trên máy dev vẫn skip (đúng), nhưng ở **job tồn tại để chứng minh
   tranh chấp khoá** thì skip là 12 file concurrency in chữ "skipped" trong một báo cáo xanh. URL
   **rỗng** tính là thiếu: `eval "$(test-pg.sh start)"` in ra rỗng vẫn exit 0.
3. **"`playwright-engine.ts` là file DUY NHẤT chạm Playwright" từ comment thành luật** —
   `no-restricted-imports` + twin `no-restricted-syntax`, override đúng một path. Override **nêu lại**
   luật zero-credential vì flat config **GHI ĐÈ** options chứ không gộp (có fixture riêng cho đúng cái
   bẫy đó). Dùng `regex` chứ không `group`: glob của `group` khớp theo từng path segment nên
   `playwright-*` bắt nhầm chính adapter — **một luật bắn vào code đúng là một luật sẽ bị xoá**.
4. **`routes/internal.ts` dùng `z.enum(LANES)`** thay vì gõ lại literal, cộng 4 chốt: trần kích thước
   artifact khớp giữa contract và cột; danh sách lane khớp giữa wire và **CẢ HAI** CHECK constraint
   đọc từ DB đã migrate; hai ca âm INSERT + một ca âm 400 (`lane` là bộ đóng duy nhất của M3 chưa có
   ca âm nào). Kiểm chứng bằng **đột biến**: đổi trần đi 1 ⇒ đỏ; thêm lane thứ ba ⇒ đỏ.
5. **`fleet-soak` chạy `test:host` trên chính runner non-root đó.** `chromium-sandbox.test.ts` là test
   **DUY NHẤT** đo thực nghiệm rằng chromium mặc định lên **CÓ** sandbox — nhưng **không job nào từng
   đặt `TESTKITE_HOST_CGROUP`** ⇒ nó chưa từng chạy ở đâu. Kèm chốt uid: file tự skip dưới root, mà
   `vitest run` trên một file skip hết **vẫn exit 0** ⇒ không có chốt thì step này chính là thứ cả lô
   đang dẹp.

**Verify:** typecheck + test + lint + test:tools + lint:cycles + openapi:check ⇒ exit 0.
**1300 test** (core 697, runner 294, run-compiler 179, contract 84, verb-kit 12, tools 34) — không
mục nào giảm so với 1250 đầu đợt.

## 4. Nhóm phát hiện hạ tầng của M3

Đây là lớp lỗi **không nằm trong logic nghiệp vụ** mà nằm ở tầng dưới nó — DB, tiến trình, đồng hồ,
gate. Mỗi dòng: **triệu chứng → nguyên nhân gốc → cách bắt được**.

1. **Outbox relay publish trùng** (`c0c2f42`) — test "each event is published EXACTLY ONCE" đỏ 1/5
   lần → câu gộp `WHERE … NOT EXISTS(consumed) … FOR UPDATE SKIP LOCKED` lấy **snapshot lúc câu lệnh
   BẮT ĐẦU** nhưng chỉ giành row lock **SAU** khi tính xong vị từ, nên relay kia commit chen vào khe
   đó thì `consumed` còn **vô hình** với `NOT EXISTS` trong khi khoá của nó đã nhả → bắt bằng psql
   trực tiếp: nhét `pg_sleep(2)` vào giữa vị từ, commit `consumed` từ session khác ⇒ tái hiện 100%;
   sửa bằng **tách hai câu lệnh** (khoá trước, hỏi `consumed` sau) trong cùng transaction.
2. **`pg.Pool` thiếu handler `'error'`** (`062aad2`) — không triệu chứng nào cho tới khi DB chớp;
   một kết nối **đang ngồi idle** bị server cắt (restart/failover/`pg_terminate_backend`) → pg-pool
   phát lại lỗi **trên pool**, mà EventEmitter không có listener `error` thì **NÉM** thay vì phát ⇒
   uncaught exception giết **đúng tiến trình đang chạy reaper + relay** → bắt bằng
   `test/concurrency/pool-idle-disconnect.test.ts`: giết backend idle từ một kết nối khác ⇒
   `Uncaught Exception … 57P01` đi qua `pg-protocol → idleListener`.
3. **Test concurrency chạy trên PGlite là bằng chứng GIẢ** (`629a372`) — `reserveRunSlot` được công
   bố NGUYÊN TỬ, test reserve trong vòng `for` có `await` **tuần tự** và luôn xanh → PGlite chỉ có
   **MỘT kết nối wasm**, nên "transaction song song" thực ra xếp hàng: không có tranh chấp thì không
   có gì để đo → bắt bằng cách dựng `quota-race.test.ts` trên Postgres THẬT, 8 kết nối, **gate chỉ mở
   khi cả 8 đã BEGIN** (không gate thì `Promise.all` trên pool nguội cũng không song song), rồi
   **đột biến** bản đang chạy: tách câu nguyên tử thành read-then-write ⇒ đỏ `expected 8 to be 4`,
   trong khi tầng PGlite vẫn XANH cả hai lần.
4. **`DISPATCHER_ID` mặc định theo hostname ⇒ split-brain VĨNH VIỄN** (`8b08b68`) — hai tiến trình
   dispatcher trên cùng host **cả hai** được báo là leader ở mọi tick → `holder` là toàn bộ danh tính
   mà `acquireOrRenewLease` fence lên, và nhánh `holder = me` được định nghĩa là **RENEW** chứ không
   phải giành quyền, nên `epoch` **không bao giờ tiến** và fencing của `job_runs` cũng không tách
   được chúng (không phải "cửa sổ tự sửa" như comment mô tả) → bắt bằng `dispatcher-leader.test.ts`
   trên Postgres thật với **hai `pg.Pool` độc lập**: ca cùng holder ⇒ cả hai thắng ở cả 3 vòng và
   epoch đứng yên; sửa bằng `defaultDispatcherId() = <hostname>#<pid>`.
5. **`touchWorker` không gia hạn `token_expires_at`** (`b873258`) — worker heartbeat 5s liên tục quá
   24h bị `verifyWorkerToken` trả `null`, máy đang sống bị coi là chưa xác thực → `token_expires_at`
   đóng dấu **một lần** lúc register ⇒ TTL đo "thời gian kể từ lần restart gần nhất", **không** đo
   thời gian im lặng như hợp đồng hứa; test cũ chỉ phủ ca **không** có heartbeat xen giữa nên lỗ hổng
   im lặng → bắt bằng test "renews the worker token on every heartbeat…": register t0 → heartbeat
   t0+23h → token còn sống ở t0+36h **và chết ở t0+23h+25h** (cửa sổ TRƯỢT, không phải ân xá).
6. **Thiếu unique constraint đỡ cho luật đọc `MAX(attempt)`** (`91ce28d`) — hai lần ghi ĐỘC LẬP cùng
   `(team, job, case, attempt)` **đều commit**, sinh 2 dòng `res_case_results` + 2 dòng con, và
   `latestCaseResults()` trả về dòng có `started_at` lớn hơn — **verdict do đồng hồ hệ thống chọn**,
   im lặng → `UNIQUE (…, attempt, started_at)` **luôn phải** chứa `started_at` (Postgres từ chối
   unique key thiếu partition key), mà `started_at` là giá trị **CALLER đưa vào** ⇒ constraint không
   bao giờ va chạm → bắt bằng hai connection độc lập trên Postgres thật; sửa bằng bảng **không
   partition** `res_case_result_keys` PK `(team_id, job_run_id, case_id, attempt)` giành bằng
   `INSERT … ON CONFLICT DO NOTHING RETURNING` (không dùng `WHERE NOT EXISTS` — đúng lỗi vừa vá ở
   `c0c2f42`).
7. **429 khai trong bảng hợp đồng mà chưa cài ở đâu** (`cfca282`) — bảng "Mã lỗi trả về từ
   /internal/fleet" liệt kê thẳng `429 RATE_LIMITED … backoff mũ jitter theo Retry-After`, nhưng bản
   ship đầu **không có throw nào**, descriptor `internalClaim` chỉ khai `{200, 204, 401}`, không có
   test claim-storm → lệch hợp đồng thật (không nằm trong 3 điểm "sai lệch có chủ đích" mà T13 tự
   khai); hậu quả rơi vào **20 task của plan fleet** sẽ code backoff cho một mã server không bao giờ
   trả → bắt bằng đối chiếu bảng mã lỗi với descriptor + grep throw; sửa bằng token bucket
   (10/s, burst 20) **xuất từ contract**, trừ ngân sách **TRƯỚC** khi chạm hàng đợi (phanh sau
   `claimJobs` còn tệ hơn không phanh: job đã rời queue rồi mới 429 ⇒ chain treo `running` 30s).
8. **`id:` của SSE dùng chỉ số mảng thay vì con trỏ ổn định** (`80c47fc`) — client nối lại bị **mất**
   sự kiện mới và **nhận lại** sự kiện cũ đánh số lại như mới → `readRunEvents` sắp xếp toàn cục theo
   `(attempt, seq, job_run_id)` nhưng `attempt`/`seq` là bộ đếm **RIÊNG của từng chain** (mỗi
   `job_run` bắt đầu lại từ 1), nên một chain lên tiếng muộn sinh ra bộ ba sắp **TRƯỚC** con trỏ đã
   ack; run ≥2 chain là ca **THƯỜNG**, không phải biên → bắt bằng `sse.test.ts` regression multi-chain
   qua socket thật (chain B lên tiếng sau 3 frame của A ⇒ id phải là 1,2,3,4) + `run-event-ordinal-race`
   trên Postgres thật; sửa bằng `orc_run_events.run_ordinal` cấp phát bằng một câu UPDATE **khoá hàng
   `orc_runs`** (nextval rẻ hơn nhưng sai: nó phát số mà không khoá).
9. **Khẳng định SAI rằng Chromium chạy sandboxed** (`1eb21bd`) — 4 chỗ (blueprint §5, header engine,
   comment tại chỗ launch, commit message T12) nói "sandbox BẬT, không bao giờ `--no-sandbox`", trong
   khi `/proc/<pid>/cmdline` thật nói ngược lại → `launchPlaywrightEngine()` không truyền
   `chromiumSandbox`, mà playwright-core mặc định `false` và **tự thêm `--no-sandbox` trừ khi
   `chromiumSandbox === true`** (`chromium.js:288`); 6 test real-browser không test nào soi trạng thái
   sandbox nên lời khẳng định sai đi qua 130 test và toàn bộ verify xanh → bắt bằng đọc cmdline thật
   của browser; sửa hai nửa: mặc định `chromiumSandbox: true`, và opt-out **tường minh**
   `sandbox: "off-root-dev-only"` mà `resolveChromiumSandbox()` (hàm thuần) **chỉ** chấp nhận cho
   uid 0 — uid khác thì **NÉM** thay vì tụt hạng, nên container uid 10001 không thể âm thầm rơi về
   `--no-sandbox`.
10. **`interface` khai tay không phân biệt được với kiểu dẫn xuất từ schema** (`96a38ab`) — control
    plane thêm một trường vào `claimedJobSchema` thì `decodeBody` parse ngon lành, nhưng object
    literal dựng job trong `claim()` liệt kê tay 10 trường nên **đánh rơi trường mới trong im lặng**,
    không build nào trong fleet đỏ → TypeScript là **structural**: một `interface` khai tay đúng 10
    trường của hôm nay không phân biệt được với kiểu dẫn xuất, cả lúc biên dịch lẫn lúc chạy; hai kiểu
    chỉ tách nhau vào **ngày contract thêm trường** → vì vậy guard phải gác trên **CHÍNH KHAI BÁO**
    (test đọc `Object.keys(claimedJobSchema.shape)` và soi cách `ClaimedJob` được khai), không thể gác
    bằng một assertion cấu trúc.
11. **Test ngủ cứng 500ms rồi đếm renderer ⇒ đỏ giả khi chạy song song** (`96a38ab`) — test chống rò
    renderer của T12 xanh khi chạy riêng, đỏ khi chạy cả suite → sau `close()` một renderer vẫn còn
    trong `/proc` với **RSS 0** (đang thoát, **không** phải rò), và 500ms là một con số **đoán** chứ
    không phải trần đã đo → bắt bằng chính lần verify bị chặn; sửa bằng **poll tới trần settle đã đo
    trên host này** (1,5s, nhân đôi làm biên) — rò thật vẫn đỏ, chỉ đỏ muộn hơn.
12. **`runnerd` gọi `unref()` lên timer keep-alive của chính nó** (`c469779`) —
    `runnerd.service` in "runnerd up …" rồi **thoát code 0 gần như tức thì, chưa register lấy một
    lần**; vì exit 0 không phải failure nên `Restart=on-failure` cũng không khởi động lại → interval
    đó là **handle ref duy nhất** của tiến trình (`main()` đồng bộ, không mở socket lắng nghe vì lệnh
    đi về trên RESPONSE của heartbeat; và `process.on("SIGTERM")` tự nó **không** ref event loop) →
    16 test cũ vẫn xanh vì chúng chạy dưới `vi.useFakeTimers()`, mà fake timer gọi callback trực tiếp
    và **không bao giờ đụng cờ ref/unref của handle thật**; bắt bằng spawn một **TIẾN TRÌNH THẬT** nối
    dây y hệt `main.ts`: bản cũ in "booted" rồi exit 0 không một dòng "beat", bản bỏ `unref()` beat
    1..12 liên tục.
13. **Timer thua cuộc của `Promise.race` không `clearTimeout`** (`0360993`) — sàn RSS node **bò
    0,55MB/chain** trong soak 200 chain → heap snapshot diff (chain 50 vs 150) chỉ đúng thủ phạm: mỗi
    chain giữ nguyên **một `RunPlan` đã parse**, chuỗi tham chiếu là timer → closure → `reject` →
    promise → frame đang chờ → `deps` → `onStep` → `ClaimedJob` → `plan`; 9 timer mỗi chain (8 step +
    1 chain), sống tới 60s/180s. **`unref()` KHÔNG cứu: nó bỏ giữ event loop, không bỏ giữ bộ nhớ** →
    bắt bằng soak thật + test ĐỎ dùng `vi.getTimerCount()` (ĐỎ = 4 timer treo); sửa bằng
    `raceDeadline()` clear trong `finally`.
14. **Test "flaky-by-design" đóng dấu đồng hồ TƯỜNG vào một khẳng định hợp đồng** (`0ba1d18`) — test
    claim-storm fail một lần **ngay trong đợt verify bắt buộc** (`expected 204 to be 429`) rồi xanh
    lại ở hai lần chạy kế → route claim đọc `Date.now()` thật, còn test bắn 60 request HTTP **tuần
    tự** qua Postgres rồi khẳng định request thứ 61 phải là 429; bucket refill 10 token/giây **trong
    khi vòng lặp chạy**, nên kết quả là hàm của **độ trễ round-trip**, tức của tải máy, không phải của
    hợp đồng (đo được: 22/60 phục vụ trong khi burst chỉ là 20) → bắt bằng đo chính đại lượng đó; sửa
    bằng cổng `claimClock?: () => number` **chỉ** cho budget claim (production không truyền gì và nhận
    `Date.now`) và đổi khẳng định sang **số học đúng**. *Bài học chung với #11: một test khẳng định
    đại lượng nó không điều khiển là flaky theo thiết kế — và dự án này đã trả giá, một test dán nhãn
    "flaky" từng che giấu một race THẬT suốt 2 milestone.*

## 5. Trạng thái 3 exit criteria của M3

Chép trung thực từ `M3-orchestration-fleet.md` mục "Exit criteria". **Không mục nào được tick.**

### EC-1 — "Giết -9 một worker giữa chừng: chain requeue đúng 1 lần, zombie bị 409, kết quả đọc `MAX(attempt)`."

**Đã có bằng chứng đo được (tầng control plane, Postgres THẬT, 8 kết nối song song có `warmPool`):**
`apps/core/test/concurrency/lease-epoch-race.test.ts` — *"requeues the chain exactly once and rejects
every later write from the zombie"*, *"costs one attempt per death even when two reapers sweep at the
same instant"*, *"keeps SKIP LOCKED honest while the reaper is running concurrently with a claim"*.
Số học ngưỡng/attempt/epoch + requeue **đầu** hàng đợi team: `test/orchestration/reaper.test.ts`.
Luật đọc `MAX(attempt)` đứng trên khoá idempotency thật sau `91ce28d`
(`res_case_result_keys`), có `result-attempt-race.test.ts` giữ.

**CÒN NỢ — không được đọc là đã xong:** cái chết trong test được mô phỏng bằng `ageHeartbeat(…, 31)`
("kill -9 thì heartbeat đơn giản **dừng**; chính sự vắng mặt là tín hiệu"). **Chưa có lần nào SIGKILL
một tiến trình worker THẬT đang lái chromium thật, đối diện control plane thật.** Phía fleet, zombie
tự sát + `409 STALE_EPOCH` **không** retry chỉ được chứng minh qua `FakeControlPlane` (schema contract
thật, socket thật) — nó chứng minh **worker NÓI ĐÚNG hợp đồng**, không chứng minh server thật phục vụ
đúng. ⇒ **host pilot.**

### EC-2 — "Ép một chain ăn RAM vô hạn: kernel giết đúng Chromium, node báo `browser_oom` kèm peakRss, container khác + API không hề hấn."

**CHƯA ĐO ĐƯỢC PHẦN CỐT LÕI.** Soak T19 **không áp trần cgroup nào** (sandbox cgroup v1 hybrid, không
`CAP_SYS_RESOURCE`); `/proc/pressure/memory` **không tồn tại** ở đây.

Cái **đã** có: quy tội bộ nhớ theo context trên chromium THẬT (`db82d95` — bơm 200MB vào context B ⇒
A 74,9→75,0MB, B 74,9→284,9MB, hai tập pid renderer rời nhau); `MemoryLimiter`/`OomReporter` đọc
`memory.events` và tự chẩn `browser_oom` trên cgroup fake; và sau Lô 2, một cgroup **không đọc được**
không còn bị đọc thành `0 current, 0 oom_kill` (`MemorySnapshot.unreadable`) — tức lỗi chẩn đoán
"OOM thật báo là chain khoẻ" đã bị bịt **trước** khi lên host.

"**API không hề hấn**" **không** do phép đo nào chứng minh: `apps/core` không tham gia soak. Nó phẳng
vì ảnh API không bao giờ chứa browser — điều được giữ bằng **gate CI browser-free** (mới được sửa cho
hết mù ở Lô 3 item 1), không phải bằng một phép đo.

⇒ **Còn nợ toàn bộ:** `test/host/cgroup-v2.test.ts` + `test/host/oom-score.test.ts` trên host thật.

### EC-3 — "24 context song song chạy hết đêm synthetic không OOM host."

**Đúng MỘT NỬA, có số đo lặp lại được** (`0360993`, soak 200 chain, 178,7s, chromium
`headless-shell` THẬT + `Worker` thật + `FakeControlPlane` qua socket thật):

```
SOAK REPORT {"chains":200,"nodeRssBootBytes":123645952,"nodeRssStartBytes":153493504,"nodeRssEndBytes":161300480,"nodeRssFinalBytes":161488896,"browserTreeRssPeakBytes":240046080,"orphanChromiumAfter":0,"contextsLeaked":0,"msPerChainP50":877,"recycles":4}
```

Sàn RSS 153,5→161,3MB = **105,1%** (trần 130%) · đỉnh cây chromium 240,0MB (trần L1 3072MB) ·
**0 orphan** đo SAU settle 1,5s (đo ngay ra 2 process ⇒ **ĐỎ GIẢ**) · **0 context rò** · 4 lần recycle
browser THẬT (nên "0 orphan" đứng trước 5 lần chromium chết, không phải 1). Ba lần chạy liên tiếp:
105,5% / 105,1% / 103%.

**CÒN NỢ:** soak chạy **200 chain TUẦN TỰ, 1 context/chain** — nó đóng phần *"không rò, không orphan
qua nhiều lần recycle"*, **không** đóng phần *"24 context SONG SONG"* lẫn *"hết đêm"*.
`msPerChainP50` chỉ để theo dõi **xu hướng** (box 4 vCPU dùng chung), **không** phải số capacity fleet.

### Ghi chú xuyên suốt cả 3 tiêu chí — hình thái sandbox

Box này chạy **uid 0**, Chromium từ chối bật sandbox và playwright thêm `--no-sandbox` trừ khi
`chromiumSandbox === true` ⇒ **mọi số ở trên là số KHÔNG sandbox**. Hình thái production (uid 10001,
sandbox bật) chỉ nghiệm thu được ở `test:host` (`test/host/chromium-sandbox.test.ts`) và ở job nightly
`fleet-soak` trên runner GitHub non-root. Job đó **mới được nối dây ở `95f1c26`** (trước đó không job
nào đặt `TESTKITE_HOST_CGROUP` ⇒ test sandbox chưa từng chạy ở đâu) — **báo cáo này không trích dẫn
được một lần chạy nightly nào đã hoàn tất.**

### Điều kiện chặn nghiệm thu — ĐÃ GỠ (kiểm lại 31-08-2026)

Bản đầu của báo cáo này đặt một điều kiện chặn: `test/concurrency/relay-race.test.ts` còn đỏ ngắt
quãng với chữ ký của một bản sao thật (`expected 20 to be 21`). **Điều kiện đó dựa trên dữ liệu đã cũ**
— hai lần đỏ được trích đều xảy ra TRƯỚC `c0c2f42`, commit sửa đúng nguyên nhân gốc đó (khoá hàng
trước, kiểm `consumed` ở câu lệnh riêng). Nghiệm thu lại sau polish: **8 lượt liên tiếp trên Postgres
thật đều 5/5 xanh**. Không còn điều kiện nào chặn nghiệm thu M3 vì lý do này.

NIT 73 **đã trả** ở commit `7864932` và NIT 12 ở commit `81e8c06` (đợt M3-debt, plan
`plans/2026-08-31-m3-debt.md` Task D1 và D2). Mục hoãn còn lại là **NIT 4** (tách vai DB), vẫn nguyên
hiệu lực theo mốc đã ghi ở mục 2.2 — địa chỉ trả: Task D3 của cùng plan đó.
---

**Verify của chính đợt polish** (`95f1c26`): typecheck 6/6 · 1300 test xanh · lint sạch ·
`lint:cycles` không chu trình · `openapi:check` sạch · `pnpm run test:tools` = 34/34 (2 file).
