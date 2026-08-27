# @testkite/run-compiler

Pure function `compileRun(input)` — phase 1→7 của Run Compiler (blueprint
[`docs/SYSTEM_DESIGN.md`](../../../docs/SYSTEM_DESIGN.md) §4): snapshot authoring → `RunPlan`
bất biến, content-hashed. Không fs/net/db, không `Date.now()`/`Math.random()` trong đường sinh
plan — **cùng input ⇒ cùng `contentHash`, mãi mãi**.

## Golden suite (tầng test T1)

`fixtures/` là **hợp đồng của toàn hệ**, không phải "thêm vài test cho chắc". Worker chạy đúng
cái plan compiler sinh ra, dispatcher tính cost từ `stepCount` của nó, kết quả được quy chiếu về
`contentHash` của nó — nên một thay đổi vô ý trong compiler không hỏng "một test", nó **đổi
nghĩa của dữ liệu đã lưu**. Golden file là ảnh chụp có kiểm duyệt của cái nghĩa đó: đổi được,
nhưng phải đổi có chủ ý, và diff phải nằm trong PR cho người khác đọc.

```
fixtures/<tên>.json          # input: mô tả + expect + CompileSnapshot
fixtures/<tên>.golden.json   # output: CompileOutput canonical (khoá sort đệ quy, thụt lề 2)
```

Mỗi fixture tự khai nó dương hay âm, và runner đối chiếu lời khai đó với thực tế TRƯỚC khi so
golden — nên một lần update vô ý không thể lặng lẽ biến fixture âm thành dương:

| field | ý nghĩa |
|---|---|
| `name` | phải trùng tên file (runner cưỡng chế) |
| `description` | fixture này giữ hợp đồng nào — hiện ra trong tên test |
| `expect` | `plan` (phải compile ra plan) hoặc `diagnostics` (phải hỏng) |
| `expectCodes` | với `expect: "diagnostics"`: đúng bộ `CompileErrorCode` phải xuất hiện |
| `lane`, `screenshots` | tuỳ chọn — override policy phase 6 |
| `snapshot` | `CompileSnapshot` nguyên dạng (record đánh index theo id) |

Bộ fixture bị cưỡng chế bởi chính `src/golden.test.ts`: ≥20 fixture, **mỗi `CompileErrorCode`
có ≥1 fixture âm**, mỗi construct (action/step_group/if/for/while/rest, prereq chain sâu 5,
data-driven, `$secret`) có ≥1 fixture dương, không golden mồ côi. Thêm code lỗi mới vào
`COMPILE_ERROR_CODES` mà quên fixture ⇒ suite gãy ngay, không phải một khoảng trống im lặng.

Ngoài so golden, mỗi fixture còn bị kiểm 2 bất biến nền:

- **Xác định:** compile lại lần 2 trong cùng test phải ra canonical JSON + `contentHash` y hệt
  (bắt `Date.now()`/`Math.random()`/thứ tự Map lọt vào đường sinh plan).
- **Secret không bao giờ inline:** mọi `$secret:X` của snapshot phải còn NGUYÊN VĂN trong plan.
  Plan là payload bị hash, lưu trữ và gửi tới worker — giá trị secret lọt vào đó là lộ vĩnh viễn.

### Chạy

```bash
pnpm -F @testkite/run-compiler test:golden                  # so khớp (mặc định, dùng trong CI)
UPDATE_GOLDEN=1 pnpm -F @testkite/run-compiler test:golden  # GHI LẠI golden — rồi ĐỌC DIFF
```

Thiếu file `.golden.json` ⇒ test **fail** kèm hướng dẫn chạy `UPDATE_GOLDEN=1` (cố ý: golden
không bao giờ được tự sinh im lặng trong một lần chạy test bình thường — mất luôn ý nghĩa
"đóng dấu có chủ ý"). Vì lý do đó `UPDATE_GOLDEN=1` cùng lúc với `CI` cũng bị chặn.

`vitest -u` KHÔNG dùng ở đây: golden là file dữ liệu do runner tự quản, không phải snapshot của
vitest.

### Thêm fixture

1. Viết `fixtures/<tên>.json` (fixture âm nhớ khai `expectCodes`).
2. `UPDATE_GOLDEN=1 pnpm -F @testkite/run-compiler test:golden`.
3. **Đọc `<tên>.golden.json` bằng mắt** — đó là bước duyệt hợp đồng, không phải thủ tục.
4. Commit cả hai file cùng nhau.

Fixture là DỮ LIỆU nên TypeScript không kiểm được nó; `src/fixture.ts` đứng thay: khoá lạ
(`verbOpkey` gõ sai) bị **từ chối** thay vì bỏ qua, sai kiểu bị từ chối kèm đường dẫn chính xác,
record phải có khoá trùng `id` bên trong.
