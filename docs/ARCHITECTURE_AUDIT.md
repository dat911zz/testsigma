# Báo cáo kiểm toán kiến trúc — Testsigma (fork tự maintain)

> **Phạm vi:** toàn bộ repo `dat911zz/testsigma` tại commit `a6155d0` (2024-06-03).
> **Bối cảnh:** nhà cung cấp (Testsigma Technologies) đã ngừng phát triển bản OSS; fork này do một người tự maintain.
> **Câu hỏi:** kiến trúc và liên kết module hiện ra sao, và có nên rewrite lại cho tối ưu không?
> **Ngày lập:** 2026-08-27.

---

## Phán quyết (TL;DR)

**Không rewrite toàn bộ. Chọn chiến lược Stabilize-in-Place (ổn định tại chỗ, hiện đại hóa từng tầng), và tháo ngòi 4 "quả bom vendor" ngay lập tức.**

- Rewrite từ đầu là bất khả thi cho một người: ~178k LOC, 4 nền tảng chạy test (web, mobile web, Android, iOS), 218 REST endpoint, 18 integration, **0 test tự động** làm đặc tả → ước tính 45–90+ tháng-người. Cả 3 nhóm phân tích độc lập đều bác bỏ.
- Tài sản thật của hệ thống không phải kiến trúc mà là: **thư viện 772 action class Selenium/Appium + catalog 586 câu lệnh NLP (`natural_text_actions`) + dữ liệu test trong ~15 bảng MySQL**. Rewrite kiểu gì cũng phải tái tạo nguyên vẹn phần này.
- Lộ trình khuyến nghị: **~14–18 tháng-người** (20–26 tháng lịch nếu làm một mình), 7 giai đoạn, mỗi giai đoạn tự đứng được — dừng giữa chừng thì hệ thống vẫn tốt hơn lúc bắt đầu.
- Kèm một **cổng thoát hiểm ở tuần 8–11**: nếu khảo sát dữ liệu (census) cho thấy bộ test thực tế nhỏ và chỉ có web → phương án "Harvest & Replace" (dịch tài sản sang Robot Framework/CodeceptJS, nghỉ hưu platform) sẽ rẻ hơn. Quyết định đó chỉ tốn ~3 tuần để mua.

---

## 1. Toàn cảnh hệ thống

Testsigma không phải hệ phân tán đúng nghĩa mà là **4 project Maven + 1 app Angular độc lập, dán với nhau bằng REST và một JAR cài tay**:

- Không có POM cha / reactor. Thứ tự build đúng chỉ tồn tại trong `deploy/compile.sh`: phải `mvn install` automator vào `~/.m2` trước thì server/agent mới resolve được (`com.testsigma:testsigma-automator:1.0.0` không có trên Maven Central — đã xác minh 404).

| Module | Vai trò | Stack | Quy mô | Tình trạng |
|---|---|---|---|---|
| `server/` | Backend REST monolith — 4 mặt API song song (UI, `api/v1`, `api/agent`, recorder) dùng chung 1 tầng service; sở hữu toàn bộ MySQL | Spring Boot **2.4.3**, Hibernate 5.5, Java 11 | 1.085 file · 66,5k LOC | EOL từ 2021 |
| `ui/` | SPA cho tester — soạn test NLP, recorder, kết quả. AppModule 257 component + `NO_ERRORS_SCHEMA` (tắt kiểm tra template toàn cục) | Angular **12.2**, RxJS 6, Material 12 | 663 file TS · ~115k LOC (TS+HTML+SCSS) | EOL từ 2022 |
| `automator/` | Engine chạy test Selenium/Appium — **tài sản giá trị nhất**; được server (in-process) và agent (process riêng) nhúng làm JAR, giao tiếp qua interface `AppBridge` (14 method) | JAR thuần, Selenium 4.8.2, Appium client 8.3 | 1.081 file · 32,9k LOC | Đóng băng |
| `agent/` | Runner trên máy tester — poll server mỗi 3s lấy việc; adb/ddmlib (Android), usbmuxd tự viết (iOS); mở Jetty local :9393/:9494 cho browser gọi thẳng | Spring Boot **2.3.0** | 118 file · 8,7k LOC | EOL từ 2020, stale nhất repo (commit cuối 2023) |
| `agent-launcher/` | Shell system-tray, spawn `agent.jar`, giữ socket loopback báo sống/kill | Java thuần | 4 file · 0,6k LOC | Có menu item chết |

**Số liệu then chốt (đều đã xác minh trực tiếp):**

- 218 REST endpoint / 97 controller — **không có OpenAPI/Swagger**.
- 61 bảng MySQL · 70 JPA entity · 65 migration Flyway thật (`db/migration`) + 92 script bootstrap riêng (`db/bootstrap`) phải giữ tương đương bằng tay.
- 586 dòng `natural_text_actions` map câu lệnh NLP → 542 class Java, gọi bằng `Class.forName` (reflection) lúc runtime.
- **0 test tự động** trên cả 4 module Java (không có `src/test` nào); UI có đúng 1 file spec 16 dòng, và `karma.conf.js`/`src/test.ts` được angular.json trỏ tới nhưng **không tồn tại** → `ng test` không chạy nổi.

### Bản đồ liên kết

```
ui (Angular, browser) ──REST ~218 endpoint (same-origin qua nginx)──▶ server ──JPA + 75 native SQL──▶ MySQL (61 bảng)
        │                                                              ▲   ╲
        │  wss:// trực tiếp :8484 (mirror màn hình mobile,             │    ╲ (đứt, ĐỎ) 19 điểm gọi: telemetry đồng bộ,
        │  qua DNS vendor local.testsigmaagent.com)                    │     ╲ cert agent, addon store, visual test…
        ▼                                                              │      ▼
      agent ──────────────poll REST mỗi 3s, JWT Bearer─────────────────┘   os-services.testsigma.com (VENDOR — ĐÃ CHẾT)
   [automator JAR nhúng]                                                   s3://hybrid-staging.testsigma.com (VENDOR — installer)
      server cũng nhúng automator JAR (chạy test standalone trong chính JVM API)
```

Automator không phải service riêng: là JAR nhúng chạy chung JVM ở cả hai nơi, nói chuyện với thế giới qua `AppBridge` — server cài `StandaloneAppBridge` (gọi bean trực tiếp), agent cài `CloudAppBridge` (gọi HTTP về server).

---

## 2. Bốn quả bom hẹn giờ vendor (xử lý TRƯỚC mọi kế hoạch nâng cấp)

Vendor không chỉ ngừng code — họ để lại **phụ thuộc runtime vào hạ tầng SaaS của chính họ**. Ngày các domain này chết hẳn (hoặc bị parked/sinkhole), hệ thống hỏng theo dù code không đổi.

1. **Agent từ chối khởi động nếu không gọi được vendor.** `AgentWebServer.fetchWebServerCertificate()` lấy cert HTTPS local qua server, server **proxy thẳng sang `os-services.testsigma.com`**. Thất bại → `Runtime.getRuntime().exit(-1)` (`AgentWebServer.java:58`). Cert không bao giờ cache xuống đĩa. Domain chết = mọi agent vĩnh viễn không boot được.
   → *Sửa: tự sinh self-signed cert + cache đĩa, xóa lệnh exit. Hotfix số 1 của toàn dự án.*
2. **Telemetry đồng bộ, không tắt được, bắn về host chết.** `TestsigmaOsStatsService` + 11 `@EventListener` (không `@Async`) POST **không xác thực** lên vendor mỗi lần tạo/xóa test case/suite/step/element/plan… ngay trên request thread, timeout 2 phút connect / 10 phút socket. Domain bị parked → mỗi thao tác CRUD có thể treo tới 2 phút. Không có cờ tắt.
   → *Sửa: xóa toàn bộ package `os/stats/`.*
3. **Pipeline installer không thể tái tạo.** Cả 4 workflow release chạy `aws s3 cp s3://hybrid-staging.testsigma.com/…` bằng secret AWS vendor để lấy JRE/nginx/Android SDK/iOS tooling/Appium nhồi vào zip installer. Bucket riêng, không manifest, không mirror. **Tin tốt đã kiểm chứng:** `deploy/compile.sh` (build lõi server + UI + agent) hoàn toàn không đụng vendor — sản phẩm chính vẫn build được từ source sạch.
   → *Sửa: bỏ installer zip; phân phối agent bằng Docker image + zip bring-your-own-JRE có tài liệu.*
4. **~19 tính năng âm thầm nối vào một URL vendor duy nhất.** `testsigma.platform.url` (mặc định `os-services.testsigma.com`) tỏa ra ~19 class: addon marketplace "Kibbutz", visual testing, NLP suggestion, cloud/private device grid, resign app iOS, parse provisioning profile…
   → *Sửa: cờ `vendor.cloud.enabled=false` chặn 19 điểm gọi bằng thông báo "tính năng đã ngừng" tử tế.*

**Lộ bí mật thật sự cần xử lý ngay:** `run-and-debug/nginx/ssl/local_testsigmaos_com.{key,pem}` chứa **private key + cert wildcard DigiCert thật của `*.testsigmaos.com`** (hạn 11/2024) vẫn tracked tại HEAD — `.gitignore` thêm sau nhưng file chưa từng bị gỡ → cần purge khỏi git history. Cùng nhóm: Google OAuth client secret, mật khẩu mặc định `admin@sample.com/admin`, `root/root` đều nằm trong `application.properties`.

---

## 3. Các điểm ghép nối và độ khó khi tháo

Điểm sáng: **đường ghép giữa module khá sạch** (REST + một interface Java duy nhất) → hệ thống *có thể* hiện đại hóa từng phần. Điểm tối: **hợp đồng dữ liệu hoàn toàn bằng niềm tin** — DTO copy-paste tay ở ba phía, sai lệch chỉ lộ lúc runtime.

| Cạnh nối | Cơ chế | Rủi ro | Độ khó tháo |
|---|---|---|---|
| UI → Server | REST same-origin; ~65 URL constant (`url.constants.service.ts`) soi gương 97 controller; deserialize bằng 143 model `serializr` | Không OpenAPI — đổi tên field phía server là UI hỏng im lặng | Thấp |
| Agent → Server | Poll REST mỗi 3s (`RunScheduler`), 24 URL builder, JWT Bearer; không có push | JWT truyền qua query param lúc đăng ký; server hardcode version agent "3.0.1" trong khi pom ghi 1.3.0 | Thấp |
| Server/Agent ⇄ Automator | JAR nhúng + `AppBridge` 14 method, sẵn 2 implementation — **seam tốt nhất repo** | Hai implementation phải tự giữ tương đồng bằng tay | Thấp — giữ làm seam |
| DTO 3 phía | ~28 class trùng tên automator/server (5 file byte-identical; phần còn lại **đã drift**: `WorkspaceType` phía server có thêm `IOSWeb`); convert bằng Jackson serialize→deserialize | Thêm field một phía, quên phía kia → rơi field im lặng | Trung bình |
| Automator ⇄ DB `natural_text_actions` | 586 dòng SQL seed map câu NLP → FQCN, gọi bằng reflection | Đổi tên class quên migration = keyword chết lúc runtime, không lỗi compile. **Ràng buộc trung tâm của sản phẩm** | Cao — cần validator lúc boot |
| UI → Agent trực tiếp | `wss://local.testsigmaagent.com:8484` + HTTPS :9494 — DNS công cộng vendor alias về localhost | Domain vendor hết hạn = mất mirror thiết bị | Trung bình |
| Server → MySQL | Dialect ghim `MySQL5InnoDBDialect`; 75 native query chứa cả logic copy/version workspace trong chuỗi SQL | Không đổi DB được; bù lại native query đi qua Hibernate 6 gần như nguyên vẹn | Trung bình |

---

## 4. Nợ kỹ thuật & lỗ hổng đáng giá nhất

| Hạng mục | Bằng chứng | Mức độ |
|---|---|---|
| Zero test toàn cục | Không `src/test` nào trong 109k LOC Java; UI 1 spec rỗng; hạ tầng test UI hỏng | **Chặn mọi nâng cấp** |
| Agent local API mở toang | `WebConfig`: `permitAll()` + CORS `*`, bind mọi interface → web page bất kỳ/LAN có thể re-register agent sang server kẻ tấn công, chụp màn hình phiên test, kill agent | **Sửa Phase 0** |
| CSRF tắt + auth cookie | `http.csrf().disable()` trong khi JWT đọc từ cookie | **Sửa Phase 0** |
| Addon = RCE by design | `AddonService` tải JAR từ URL, nạp `URLClassLoader`, không chữ ký/checksum; singleton **không thread-safe** (2 test song song đè classloader nhau) | Thiết kế lại nếu giữ addon |
| God class/component | `AgentExecutionService.java` 1.570 dòng, 38 dependency, ~79 public method; UI `action-step-form.component.ts` 2.310 dòng contentEditable + `execCommand` (deprecated) | Đặc tả hóa trước, refactor sau |
| Scheduler "di cư" chạy vĩnh viễn | `TestDataMigrationScheduler` + `OldResultMigrationScheduler`: mỗi 3 phút `findAll()` nguyên bảng + rewrite JSON kết quả, mãi mãi, kể cả install mới | Chuyển one-shot |
| CVE tồn đọng | jjwt 0.2, org.json 2016, gson 2.8.5, POI 3.15, jackson 2.11, mysql-connector 8.0.23; npm: node-forge, json5, loader-utils, minimist…; Docker base **CentOS 7** (mirror đã tắt — `docker build` hỏng ngay bước yum); compose ghim MySQL 5.7 | Dọn Phase 1–4 |
| 7 dependency chết | java-saml (dính CVE-2021-40699 nhưng **không được dùng**), jedis, spring-session-core, twilio, messagebird, c3p0, javax.media:jmf — 0 tham chiếu trong source (đã grep) | Xóa ngay, miễn phí |
| Flyway hack API nội bộ | `DatabaseMigrationConfig` import `org.flywaydb.core.internal.*`, cơ chế 2 đường bootstrap/migration, tự xóa-ghi `flyway_schema_history`, parse JDBC URL bằng regex | Thay Flyway chuẩn ở Phase 4 |

---

## 5. Ba phương án — chấm điểm đối kháng

Ba nhóm phân tích độc lập, mỗi nhóm bảo vệ một chiến lược hết mức, rồi một vòng phán quyết chấm chéo trên cùng bộ bằng chứng (mọi số liệu tranh cãi được kiểm chứng lại trong repo trước khi chấm).

| | **Stabilize-in-Place** ★ chọn | Strangler từng phần | Harvest & Replace |
|---|---|---|---|
| Điểm | **8/10** | 6/10 | 5/10 |
| Công sức | 14–18 tháng-người (20–26 tháng lịch solo) | 30–42 tháng-người (~4–5 năm solo) | 6–12 tháng-người *nếu trúng giả định* |
| Ý tưởng | Cắt vendor → lưới an toàn → nâng Boot 3 + Angular 16 tại chỗ | Giữ engine + schema, viết lại UI từng màn ở `/ui2/` | Tài sản thật là *dữ liệu*: 772 action class trung bình chỉ **22,6 dòng/class** (wrapper mỏng quanh Selenium); dịch catalog 586 câu + test estate ~15 bảng sang Robot Framework/CodeceptJS, nghỉ hưu platform |
| Vì sao | Mọi phase ship được độc lập; bỏ dở vẫn lời; stack cuối Boot 3/JDK 21/Angular 16+, có test, CI, OpenAPI, sạch vendor | Nửa backend trùng Stabilize; phần chênh là 14–20 tháng-người rebuild UI, tác giả tự chấm 40% khả năng về đích; kẹt giữa chừng (2 SPA song song) tệ hơn cả hai đầu | Đặt cược câu hỏi ngoài repo: người viết test có bỏ được UI no-code + recorder không; nửa đường đứt gánh = gánh 2 hệ thống. **Nếu census Phase 2 ra estate nhỏ, chỉ web → phương án này lật kèo** |

**Đồng thuận của cả ba nhóm:** (1) rewrite toàn phần 45–90+ tháng-người — loại vĩnh viễn; (2) mọi con đường bắt đầu bằng cùng hai tuần tháo bom vendor; (3) **bỏ hỗ trợ iOS native** (usbmuxd tự viết + binary vendor không build lại được) — hướng người dùng sang Appium 2 + `appium-xcuitest-driver`.

---

## 6. Lộ trình khuyến nghị (7 giai đoạn)

Hai **cổng cứng**: không đụng version framework trước khi lưới an toàn xanh (Phase 3); hóa đơn Material MDC tách riêng, đo trước khi trả (Phase 6).

### Phase 0 — Containment: tháo ngòi + sàn bảo mật (tuần 1–6)
- Chứng minh build sạch theo `deploy/compile.sh` (ghim JDK 11 + Node 16) → viết `BUILDING.md`; `mysqldump` + diễn tập restore; tag baseline `a6155d0`.
- Self-signed cert + cache đĩa cho agent, **xóa `exit(-1)`** — verify agent boot với domain vendor bị chặn trong `/etc/hosts`.
- Xóa telemetry (`TestsigmaOsStatsService` + 11 listener); chuyển 2 scheduler di-cư thành one-shot; cờ `vendor.cloud.enabled=false` chặn ~19 điểm gọi còn lại.
- Sàn bảo mật: CSRF/SameSite cho cookie auth; khóa 8 controller `permitAll` của agent + bind `127.0.0.1` + bỏ CORS `*`; purge key DigiCert khỏi git history; xoay toàn bộ secret/mật khẩu mặc định.

### Phase 1 — Build & CI thật (tuần 4–8, chồng lấn)
- POM aggregator gốc đúng thứ tự reactor (automator → agent → agent-launcher → server); `.nvmrc` + `engines`.
- Xóa 7 dependency chết; sửa 3 entry pom hỏng (GAV `org.apache.commons:commons-io:1.3.2` sai, property `mysq.connector.version` typo, `skyscreamer.version` khai trùng).
- Dockerfile multi-stage `eclipse-temurin` thay CentOS 7; compose lên MySQL 8.0; GitHub Actions build đủ 4 module + UI + image trên mỗi push/PR, zero secret vendor. Xóa `action.js`, `create_jira_ticket.yml`, component mồ côi `ui/src/app/src/app/...`, menu "flare" chết.

### Phase 2 — Census tài sản + văn bản chốt scope (tuần 8–11) — **CỔNG QUYẾT ĐỊNH**
- Chạy câu SQL chưa ai chạy: histogram verb thực dùng (`test_steps` ⋈ `natural_text_actions` group theo `snippet_class`, `workspace_type`); đếm step group, data-driven, if/loop, `rest_step_details`, addon JAR, element theo locator type.
- Văn bản 1 trang: chính thức ngừng iOS native; mức hỗ trợ mobile theo số đo; danh sách tính năng vendor-SaaS xóa hẳn vs. stub.
- **CỔNG:** census ra estate nhỏ, chỉ web, ít addon *và* demo Robot Framework/CodeceptJS cho người viết test thật thành công → dừng, mở lại Harvest & Replace trước khi Phase 4 tiêu tiền.

### Phase 3 — Oracle: lưới an toàn trước framework (tuần 10–22) — **CỔNG CỨNG**
- Validator lúc boot: duyệt 586 dòng `natural_text_actions` qua `Class.forName`, fail-fast (~40 dòng code — đòn bẩy cao nhất toàn dự án).
- JUnit 5 + Mockito + Testcontainers-MySQL: phủ 75 native query (nặng nhất `WorkspaceVersionRepository` 22, `TestCaseResultRepository` 16); test tương đương migration-vs-bootstrap trên schema 61 bảng.
- Sinh + commit OpenAPI (springdoc) cho 218 endpoint; golden files record/replay ghim ngữ nghĩa DSL `query=` (7 operator × 41 SpecificationsBuilder) và envelope phân trang.
- Characterization test `AgentExecutionService` (nhánh standalone vs agent); contract test round-trip `AppBridge` với `FAIL_ON_UNKNOWN_PROPERTIES` ghim trước khi bump Jackson.
- UI: tạo lại `karma.conf.js`/`src/test.ts`/`tsconfig.spec.json`; Playwright 8–10 hành trình + screenshot baseline; spike 1 ngày gỡ `NO_ERRORS_SCHEMA` để đo núi lỗi template.

### Phase 4 — Backend tại chỗ: Boot 2.4 → 2.7 → 3.x, Hibernate 6 (tuần 22–36)
- Lên 2.7 trước; chuyển đúng **2 file** `WebSecurityConfigurerAdapter` sang `SecurityFilterChain` khi còn javax.
- OpenRewrite `UpgradeSpringBoot_3_0` lo phần lớn 167 file javax→jakarta; việc tay: 21 file Criteria API, `DatabaseMigrationConfig` (thay hack internal bằng `baselineOnMigrate` chuẩn + `java.net.URI`, xóa nhánh bootstrap), jjwt 0.2 → 0.12.
- `hibernate-types-52` → hypersistence-utils → `@JdbcTypeCode(SqlTypes.JSON)`; swap `MySQL5InnoDBDialect` → `MySQLDialect`; chạy lại suite native query. Bump CVE backlog (gson, org.json, POI 5.x, mysql-connector, AWS SDK v2, Jackson đồng bộ). Target JDK 17/21.
- Kéo agent từ Boot 2.3.0 về cùng dòng; thống nhất 3 chuỗi version agent; bump webdrivermanager. **Chưa refactor** `AgentExecutionService` và 4 mặt controller — đã có characterization test giữ.

### Phase 5 — Angular 12 → 16 trên legacy Material (tuần 36–56)
- Dọn tiền đề: `relativeLinkResolution`, `entryComponents`, gỡ `NO_ERRORS_SCHEMA`/`CUSTOM_ELEMENTS_SCHEMA` + trả nợ template đã đo.
- `ng update` từng major (12→13→14→15→16), Playwright xanh mỗi trạm; import `@angular/material/legacy-*` để 443 chỗ override `.mat-*` (133 selector khác nhau) tiếp tục sống.
- Trong cửa sổ này: RxJS 6→7; moment → date-fns (33 file); thay `angular2-notifications`, `ng9-odometer`; CodeMirror 5→6; `angular-calendar`, `ng-recaptcha` mới.
- **Không** standalone components/signals/rewrite step editor. **v16 + legacy Material là điểm dừng ổn định được tuyên bố trước.**

### Phase 6 — Hóa đơn Material MDC (tách riêng, +8–14 tuần)
- Chỉ khi screenshot baseline xanh: lên v17, bỏ legacy; rewrite 133 selector SCSS + 57 class template theo bảng rename chính thức, từng họ component, screenshot-diff từng họ; theming Sass thay prebuilt theme.
- Fallback: rebuild riêng các màn tệ nhất sau route cũ; `action-step-form` (2.310 dòng) tách mini-project riêng trên editor thật (ProseMirror/Lexical/CodeMirror 6) bất kể đường nào.
- Chốt hồ sơ kế thừa: `BUILDING.md`, OpenAPI, catalog 224 verb thành tài liệu (chống bus-factor = 1).

---

## 7. Điều gì có thể lật phán quyết

1. **Ai đang viết test?** Nếu là engineer (không phải tester no-code) và chấp nhận mất UI soạn thảo + recorder → Harvest & Replace thắng TCO 5 năm. Trả lời bằng một buổi demo Robot Framework/CodeceptJS cho người dùng thật trong 90 ngày đầu.
2. **Kết quả census Phase 2.** Nặng mobile-native/nhiều addon → khóa phương án giữ platform. Nhỏ, chỉ web → mở lại phương án thay thế.
3. **Số đo Angular.** Spike `NO_ERRORS_SCHEMA` và số screenshot vỡ khi lên MDC ra gấp nhiều lần baseline 133 selector → rebuild từng màn hoặc mở lại Replace trước khi trả hóa đơn.
4. **Có thêm người/tài trợ?** Timeline 20–26 tháng solo là rủi ro cấu trúc lớn nhất. Thêm 1 người → trạng thái cuối của Strangler trở nên mua được.
5. **Bao nhiêu deployment thật phụ thuộc fork này?** Zero user ngoài → freeze-and-contain hoặc Replace quy mô cá nhân thắng mọi chương trình 2 năm.
6. **Số phận DNS vendor.** `os-services.testsigma.com` / `local.testsigmaagent.com` đã parked/sinkhole → Phase 0 chuyển từ "khẩn" thành "cấp cứu": ship hotfix cert trước mọi thứ.

---

## Phụ lục A — File đáng chú ý nhất

- `server/src/main/java/com/testsigma/service/AgentExecutionService.java` — god class 1.570 dòng, tâm điểm mọi đường chạy test.
- `server/src/main/java/com/testsigma/config/DatabaseMigrationConfig.java` — hack Flyway internal API, cơ chế bootstrap/migration 2 đường.
- `server/src/main/java/com/testsigma/config/WebSecurityConfig.java` — CSRF disable, 4 filter chain, WebSecurityConfigurerAdapter.
- `server/src/main/java/com/testsigma/os/stats/**` — telemetry đồng bộ về vendor (xóa).
- `server/src/main/resources/db/bootstrap/V207__bootstrap_natural_text_actions.sql` — 586 dòng, **file giá trị nhất repo**.
- `automator/src/com/testsigma/automator/AppBridge.java` — seam 14 method giữa engine và hai host.
- `automator/src/com/testsigma/automator/runners/ActionStepExecutor.java` — reflection `Class.forName` theo `snippet_class`.
- `automator/src/com/testsigma/automator/service/AddonService.java` — nạp JAR động không sandbox, singleton không thread-safe.
- `agent/src/main/java/com/testsigma/agent/ws/server/AgentWebServer.java` — bom cert vendor, `exit(-1)` dòng 58.
- `agent/src/main/java/com/testsigma/agent/config/WebConfig.java` — permitAll + CORS `*`.
- `ui/src/app/app.module.ts` — god module 257 declarations + NO_ERRORS_SCHEMA.
- `ui/src/app/components/webcomponents/action-step-form.component.ts` — step editor 2.310 dòng contentEditable/execCommand.
- `run-and-debug/nginx/ssl/local_testsigmaos_com.key` — private key DigiCert bị commit (purge!).
- `deploy/compile.sh` — nguồn sự thật duy nhất về thứ tự build; **đã xác minh không phụ thuộc vendor**.

## Phụ lục B — Phương pháp

Kiểm toán thực hiện bằng workflow 12 agent: 7 agent trinh sát song song (server, ui, automator, agent+launcher, hợp đồng liên module, build/deploy, nợ kỹ thuật & bảo mật), 1 agent kiểm chứng độc lập (phát hiện 6 khoảng trống — trong đó có 2 scheduler di-cư vĩnh viễn cả 7 báo cáo bỏ sót — và sửa 2 số liệu sai: 65 migration chứ không phải 157; đếm bổ sung 61 bảng), 3 agent bảo vệ 3 chiến lược đối lập, 1 vòng phán quyết chấm chéo có kiểm chứng lại bằng chứng trong source. Mọi con số then chốt trong báo cáo đều được xác minh trực tiếp trên mã nguồn tại commit `a6155d0`.
