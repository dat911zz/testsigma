# Runbook — Vai DB của TestKite

Trang đầu tiên của RUNBOOK mà `../tasks/M9-full-cutover-hardening.md` liệt kê
("Succession docs: BUILDING/RUNBOOK cập nhật").

Trang này nói về **tách vai ở tầng triển khai**: ai đăng nhập vào Postgres, họ giữ vai gì,
và giữ *như thế nào*. RLS chỉ rào một session **đã** `SET ROLE`; nó không nói gì về login role
mà session đó đi vào. Chính chỗ trống đó là thứ trang này lấp.

---

## 1. Bốn vai, và vì sao chúng tách ra

| Vai | Migration tạo | Làm gì | Vì sao tách |
|---|---|---|---|
| `testkite_app` | `0001_rls.sql` | Đường request. RLS lọc theo `app.team_id`. | Vai duy nhất bị RLS ràng buộc theo tenant |
| `testkite_relay` | `0005_outbox.sql` | Relay outbox: đọc/ghi `krn_outbox` cho **mọi** team | `krn_outbox` **không** bật RLS — cách ly bằng vai, không bằng policy |
| `testkite_auth` | `0015_api_tokens.sql` | Chỉ SELECT, để phá thế kẹt "muốn biết team phải tra token trước" | Policy `auth_lookup` là `USING (true)` trên 5 bảng ⇒ quyền này phải hẹp nhất có thể |
| `testkite_dispatch` | `0027_m3_job_runs.sql` | SELECT+UPDATE `job_runs` xuyên team (bản chất của một hàng đợi) | Policy `dispatch_all` là `USING (true)` |

Lý do đầy đủ của từng vai nằm trong docstring `../apps/core/src/modules/kernel/db/schema.ts` —
**không chép lại vào đây**, để hai bản khỏi trôi dạt khỏi nhau.

Cả bốn đều `NOLOGIN`. Không tiến trình nào *là* một trong bốn vai đó; tiến trình đăng nhập bằng
một login role rồi `SET LOCAL ROLE` sang vai cần dùng
(`../apps/core/src/modules/kernel/db/tenant.ts`: `withTenant` → app, `withAuthRole` → auth,
`withDispatchRole` → dispatch).

---

## 2. Login role: ai là ai

- `app_login` — tiến trình API. Thành viên `testkite_app` + `testkite_auth` +
  `testkite_dispatch`. **Không kế thừa vai nào.**
- `relay_login` — tiến trình relay outbox. Thành viên `testkite_relay`. **Không kế thừa.**
- owner/migration — vai RIÊNG, có DDL, **không phải** hai cái trên. Cấp bằng công cụ hạ tầng,
  không nằm trong repo này.

`apps/core` có **một** `DATABASE_URL` và **một** pool, nên `app_login` **bắt buộc** phải là
thành viên của cả ba vai — nếu không `SET ROLE` gãy ngay (`permission denied to set role`).
Vậy nên bất biến **không** phải là "cấm giữ hai vai" (điều đó cấm đúng cấu hình duy nhất chạy
được), mà là **cấm kế thừa**.

---

## 3. Kế thừa: bảng sự thật đo được (2026-08-31, PostgreSQL 16.13)

Đo trên `job_runs`, hình dạng thật: hai policy PERMISSIVE cạnh nhau —
`tenant_isolation TO testkite_app USING (team_id = app.team_id)` và
`dispatch_all TO testkite_dispatch USING (true)`. Policy permissive **OR** với nhau.

| Cấu hình login | Không `SET ROLE` | `SET ROLE app` (app.team_id = A) | `SET ROLE dispatch` |
|---|---|---|---|
| Thành viên `app`, kế thừa | team A | team A | permission denied to set role |
| Thành viên `app`+`dispatch`, **kế thừa** | **A + B — THỦNG** | team A | A + B (đúng thiết kế) |
| Thành viên cả 4 vai, **không kế thừa** | **permission denied — fail closed** | team A | A + B (đúng thiết kế) |
| `testkite_app` là thành viên của `testkite_dispatch` | — | **A + B — THỦNG dù đã SET ROLE** | — |

**Cả bốn dòng** là bốn ca `PROVES …` trong `../apps/core/test/schema/role-separation.test.ts`
(`a login holding only testkite_app` · `the hole it guards` · `the shape production must use` ·
`INV-2 is worse than INV-1`). Chúng dựng lại từng cấu hình trên Postgres THẬT rồi đọc `job_runs`
qua một connection đăng nhập bằng chính login role đó, và chạy lại mỗi lần CI chạy job
`db-tests` — nên bảng này không phải một giai thoại.

### 3b. `ALTER ROLE … NOINHERIT` KHÔNG sửa được grant đã tồn tại

Đây là cái bẫy lớn nhất của trang này. Từ **PostgreSQL 16**, kế thừa nằm trên **từng grant**
(`pg_auth_members.inherit_option`); thuộc tính `rolinherit` của role chỉ còn là **giá trị mặc định
cho những grant cấp SAU đó**.

Đo được (2026-08-31): một login tạo với `INHERIT`, được `GRANT` hai vai, rồi
`ALTER ROLE … NOINHERIT` — `pg_roles.rolinherit` báo `false`, **và nó vẫn đọc xuyên team**.

⇒ Cách sửa ĐÚNG là sửa chính cái grant:

```sql
REVOKE "testkite_dispatch" FROM <login>;
GRANT  "testkite_dispatch" TO   <login> WITH INHERIT FALSE;
```

`WITH INHERIT FALSE` **vẫn cho `SET ROLE`** (đo cùng ngày), nên đường request không hề hấn gì.

Vì lý do này, `../apps/core/src/modules/kernel/db/role-separation.ts` **không bao giờ đọc**
`rolinherit`; nó phán theo cạnh grant.

---

## 4. Cấp lần đầu

```bash
psql "$ADMIN_URL" -v app_login=testkite_prod -v relay_login=testkite_relay_prod \
     -f scripts/grant-db-roles.sql
```

Chạy **một lần cho mỗi cụm**, bằng superuser, **trước** lần deploy đầu tiên. Script tạo hai
login role rồi `GRANT … WITH INHERIT FALSE`, sau đó tự chạy luôn phần kiểm ở mục 5.

Mật khẩu / IAM auth **không** nằm trong repo: script tạo role không kèm password, phần credential
là việc của công cụ hạ tầng.

> **Nợ đã biết (M6):** `../apps/core/src/modules/kernel/outbox/relay.ts` gọi `db.execute` thẳng,
> **không** `SET ROLE`, và chưa nối vào `composition-root`. Dưới một login không kế thừa, nó sẽ
> **fail closed** đúng ngày được nối vào — đó là kết quả MONG MUỐN. Cách sửa: thêm
> `withRelayRole` như ba đường kia. Tuyệt đối không "sửa" bằng cách bật kế thừa lại.

---

## 5. Kiểm — BA thời điểm, không thương lượng

```bash
psql "$ADMIN_URL" -v check_only=1 -f scripts/grant-db-roles.sql
```

Cả ba mục phải **RỖNG**. Script `RAISE EXCEPTION` khi có vi phạm ⇒ psql thoát khác 0, dùng làm
cổng trong pipeline được ngay (`set -e`).

1. **Sau lần deploy đầu tiên của mỗi cụm**, trước khi mở traffic.
2. **Sau mỗi lần ops đụng vào role** (thêm người, thêm công cụ, đổi IAM). Vi phạm hay gặp nhất là
   **hai chặng**: cấp một "vai ops" chung rồi vô tình treo `testkite_dispatch` vào đó. Truy vấn
   cạnh trực tiếp trả **0**; closure đệ quy thì bắt được (đo 2026-08-31, và có test riêng:
   `CATCHES it through an intermediate role — two hops`).
3. **Mỗi quý**, cùng đợt drill DR của M9.

Đọc kết quả:

| Mục | Nghĩa | Sửa |
|---|---|---|
| INV-1 | Một login **kế thừa** vai `testkite_*` ⇒ câu lệnh quên `SET ROLE` chạy với **hợp nhất quyền** | `REVOKE` rồi `GRANT … WITH INHERIT FALSE` (mục 3b) |
| INV-2 | Một vai `testkite_*` là thành viên của vai `testkite_*` khác ⇒ thủng **kể cả** khi đã `SET ROLE` đúng | `REVOKE`. `WITH INHERIT FALSE` **không đủ**: `SET ROLE` vẫn với tới hợp nhất |
| INV-3 | Một login vừa giữ vai `testkite_*` vừa `SUPERUSER`/`BYPASSRLS` ⇒ RLS **không áp dụng gì cả** | `ALTER ROLE … NOSUPERUSER NOBYPASSRLS`, hoặc đổi sang login khác |

---

## 6. Giới hạn — cái gì CI chứng minh được, cái gì không

- CI (`db-tests`) chứng minh **checker bắt được từng hình dạng vi phạm**, kể cả bắc cầu, và
  chứng minh **lỗ hổng là thật** (một login kế thừa đọc xuyên team). Mỗi ca tự dựng vi phạm của
  chính nó rồi dọn đi, nên một cụm sạch không làm test xanh oan.
- CI **không** chứng minh gì về cụm production: login của CI là superuser `postgres`, và không
  migration nào tạo login role. Sự thật production **chỉ** đến từ mục 5 chạy trên chính cụm đó.
- Checker đọc `pg_roles` / `pg_auth_members` nên nó **không** thấy:
  - quyền cấp qua `pg_hba.conf` hoặc qua IAM auth của cloud provider;
  - một login được `GRANT` thẳng trên bảng mà không đi qua vai nào;
  - một login `SET ROLE` được sang một vai **ngoài** bốn vai `testkite_*` nhưng lại `BYPASSRLS`
    (INV-3 chỉ nhìn thuộc tính của chính login).

  Ba thứ đó thuộc về review hạ tầng. Runbook nói ra để không ai tưởng một dấu tick xanh ở đây là
  toàn bộ câu chuyện.
- `pg_auth_members.inherit_option` là **PostgreSQL 16+**. Repo pin PG 17 làm engine có thẩm
  quyền (CI job `db-tests`); trên cụm PG 15 trở xuống script và checker đều gãy — đó là chủ ý,
  im lặng bỏ qua sẽ tệ hơn.
