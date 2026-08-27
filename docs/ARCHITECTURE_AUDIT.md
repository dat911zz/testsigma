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

## 8. Phương án Go — "chuyển sang ngôn ngữ nhẹ hơn" (bổ sung 27-08-2026)

**Trả lời thẳng: không rewrite sang Go.** Đánh giá bởi đợt workflow thứ hai (9 agent: 3 soi repo, 2 nghiên cứu hệ sinh thái Go 2026 có kiểm chứng nguồn, 3 bảo vệ 3 kịch bản đối lập, 1 phán quyết). Nhưng cuộc điều tra đem về một việc **khẩn cấp tuần này** và đúng **một tài sản Go đáng lấy mà không cần viết dòng Go nào**.

### 8.1. Vì sao full Go rewrite chết trên chính bằng chứng

**Ma trận nền tảng vs khả năng Go (2026, đã kiểm chứng):**

| Nền tảng Testsigma phải chạy test | Go làm được không? |
|---|---|
| Desktop Chrome/Edge | ✅ chromedp / go-rod pure-Go, release mới 07/2026 |
| Desktop Firefox | ❌ Mozilla gỡ CDP khỏi Firefox cuối 2024; client WebDriver duy nhất của Go (tebeka/selenium) **chết từ 11/2021**, còn ở thời Selenium 3 |
| Desktop Safari | ❌ WebKit dùng giao thức riêng, chưa từng có đường Go |
| Mobile web Android (Chrome) | ✅ adb forward + CDP |
| Mobile web iOS (Safari) | ❌ không có đường nào (Remote Web Inspector; các bridge đều C/Node đã deprecated) |
| Android native | ❌ Appium **không có client Go** nào dùng được (cả 2 dự án cộng đồng tự nhận "not ready for any usage"); phải tự viết client UiAutomator2-server từ số 0 |
| iOS native | ⚠️ một nửa — go-ios lo device/WDA launch, nhưng client giao thức tap/swipe của WDA phải tự viết |

Ba lý do loại, mỗi lý do một mình đã đủ:

1. **Addon là hard-blocker tuyệt đối.** `AddonService` nạp *bytecode JAR do khách hàng compile* qua `URLClassLoader`; `AddonAction.java:94–265` reflection vào private field của class chưa từng link. Go không có bytecode loader → hoặc phá vỡ mọi addon khách hàng, hoặc giữ một JVM sống bên cạnh (tự phủ định lý do chuyển Go).
2. **"Một binary, không runtime" là ảo tưởng với sản phẩm này.** Appium là Node.js; driver Android gọi `apksigner` chạy JVM (agent ghim `JAVA_HOME` tại `MobileAutomationServer.java:107`). Rewrite xong thì **JRE + Node vẫn nằm trên đĩa**; thành phần nặng nhất của bundle là runtime Node của Appium (311–424MB), không ngôn ngữ nào thay đổi được.
3. **Chi phí 45–65 tháng-người** (bản cắt gọt vẫn 28–38) — bằng/vượt con số full-rewrite đã bị loại ở mục 5, để rebuild bằng tay mọi thứ Spring sinh tự động (41 Specification builder, ~298 derived query không có body, 62 mapper) trên codebase 0 test làm đặc tả.

### 8.2. Phát hiện đắt giá nhất — không liên quan ngôn ngữ

⏰ **Bucket S3 vendor VẪN CÒN SỐNG — mirror ngay tuần này.** Kiểm chứng trực tiếp trong phiên đánh giá: `s3://hybrid-staging.testsigma.com` hiện trả **HTTP 200, đọc được ẩn danh**; JRE đóng gói là **Eclipse Temurin 11.0.14.1+1 stock**. Đính chính kết luận trước: installer *hôm nay vẫn build được* — nhưng trên bucket staging của bên thứ ba có thể biến mất bất kỳ lúc nào. JRE tải lại được từ Adoptium, nhưng bản Appium đóng gói, 2 driver zip, 58 binary minicap và `windows-kill.exe` **không tái tạo được ở đúng version ghim**. → Mirror ~4,5GB về storage tự chủ (dưới 1 tuần). Nỗi đau "nặng nề" hóa ra là lỗi chuỗi cung ứng + đóng gói, sửa được bằng Java trong ~3–4 tháng-người.

### 8.3. Chấm điểm ba kịch bản

| | Full Go rewrite | Go agent + Java runner | **Deweight, đừng rewrite** ★ |
|---|---|---|---|
| Điểm | 2/10 — loại vĩnh viễn | 6/10 — hoãn, có cổng | **8,5/10 — chọn** |
| Công sức | 45–65 tháng-người | +6,5–11,5 tháng-người | **+2,75–4,2 tháng-người** |
| Nội dung | — | Daemon Go ~30MB thay 2 JVM (~250–400MB); engine test chạy trong runner JAR spawn riêng qua seam AppBridge. Chỉ mở lại khi: installer Java xanh cả 3 OS + có device lab + **cam kết văn bản automator không bao giờ port** | Mirror bucket + `fetch-deps.sh` nguồn chính chủ có checksum; jlink/AppCDS thu bundle Linux 871MB→~450–550MB (JRE 324→124→70–95MB); bỏ cây drivers 1,1GB nhờ Selenium Manager; rebase Docker khỏi CentOS 7; **go-ios dưới dạng binary dựng sẵn ghim version** thay cây Python/tidevice 163MB — chỉ sửa argv/stdout tại 4 điểm gọi subprocess Java (~1–1,5 tháng-người, zero dòng Go) |

### 8.4. Lộ trình thay đổi thế nào

Lộ trình 7 giai đoạn ở mục 6 **giữ nguyên toàn bộ**; tổng ngân sách 14–18 → ~**18–24 tháng-người** với các chèn thêm:

- **Chèn trước Phase 0, làm ngay tuần này:** mirror bucket S3 vendor (~4,5GB).
- **Phase 1 mở rộng:** `fetch-deps.sh` lấy JRE/nginx/platform-tools/Appium từ nguồn chính chủ ghim version + checksum; installer xanh trên máy sạch cả 3 OS, zero credential vendor.
- **Chèn mới — thu gọn runtime** (+0,5–0,75): JRE-image thay JDK trên Linux/macOS, jlink, AppCDS, `MaxRAMPercentage`, xóa cây drivers 1,1GB.
- **Chèn mới — swap toolchain iOS** (+1–1,5): go-ios binary ghim version thay tidevice/Python tại 4 điểm gọi subprocess (`IosDeviceCommandExecutor` + `WdaService`/`DeveloperImageService`/`IosDeviceService`); giữ nguyên sleep/retry "gánh tải" của `WdaService`; verify 1 ngày trên thiết bị thật.
- **Chèn mới — tách runner** (+1,5–2,5, sau khi có test): tách agent thành daemon + runner JAR headless spawn theo test plan — run crash không giết daemon, kill được từng run; biến Go daemon tương lai thành drop-in nếu có ngày cần. Đáng làm *bất kể* quyết định ngôn ngữ.
- **Cổng cuối viết lại:** full Go — đóng vĩnh viễn; Go agent daemon — lựa chọn hẹp duy nhất sau 3 điều kiện trên; Harvest & Replace vẫn là fallback cấp sản phẩm.

---

## 9. Thoát Java toàn phần — kế hoạch Harvest & Replace chi tiết (bổ sung 27-08-2026)

> Bối cảnh: maintainer xác nhận không muốn tiếp tục vận hành stack Java. Mục này nâng phương án Harvest & Replace (mục 5) từ "fallback có cổng" thành kế hoạch hành động đầy đủ — vì **đây chính là con đường thoát-toàn-stack đúng**, không phải rewrite bằng ngôn ngữ khác.

### 9.1. Định đề

Muốn thoát Java có hai con đường, chênh nhau một bậc độ lớn:

1. **Rewrite platform bằng ngôn ngữ khác** (Go/TS/Python…): 8–15 **năm**-người cho parity, vì phải tái tạo 218 endpoint + 4 mặt API + recorder + device lab + addon marketplace trên codebase 0 test làm đặc tả. Đã bị loại vĩnh viễn ở mục 5 và mục 8.
2. **Harvest & Replace**: không rebuild platform — **bỏ luôn platform, chỉ giữ dữ liệu**, đưa test estate sang các công cụ OSS đang được cộng đồng maintain. **6–12 tháng-người**, workspace đầu tiên chạy production ở tháng 4–6.

Điểm mấu chốt đã kiểm chứng: 772 action class trung bình chỉ **22,6 dòng/class** (696/772 dưới 50 dòng) — wrapper mỏng quanh Selenium/Appium, **mọi verb đều có bản tương đương tốt hơn, có test, đang được maintain** trong Robot Framework / Playwright / CodeceptJS. Tài sản thật nằm ở 3 thứ, đều là *dữ liệu*: catalog 586 câu (224 verb ngữ nghĩa — "hòn đá Rosetta"), test estate trong ~15/61 bảng (schema sạch, FK nhất quán), và bộ elements/locator (chuyển thẳng thành page object gần như nguyên vẹn).

Lưu ý trung thực về "Java nặng": sau khi thoát Java, **Node.js vẫn ở lại** (Appium và Playwright đều là Node) — nhưng đó là runtime của công cụ chuẩn ngành được người khác maintain, không phải 178k LOC không test mà bro phải tự gánh. Cái được giải phóng thật sự không phải RAM — mà là **quyền sở hữu đống code đó**.

### 9.2. Bảng thay thế từng thành phần

| Thành phần Testsigma (Java) | Thay bằng (OSS đang maintain) |
|---|---|
| `automator/` — 772 action class | **Robot Framework** (Browser/SeleniumLibrary/AppiumLibrary) *hoặc* **CodeceptJS** (`I.click('Login')` — đọc giống câu Testsigma nhất) *hoặc* **Playwright + TS** nếu người viết là engineer |
| `agent/` + stack usbmuxd iOS tự viết | **Appium 2 + appium-xcuitest-driver** — đã làm sẵn WDA install, DeveloperDiskImage, usbmux; cộng **Device Farmer** cho lab thiết bị |
| `server/` — nửa orchestration (`AgentExecutionService` 1.570 dòng, scheduler) | **CI runner** (GitHub Actions/Jenkins) + **Selenium Grid 4 / Selenoid / Moon** |
| `server/` — nửa kết quả/báo cáo | **ReportPortal** hoặc **Allure** |
| `suggestion/` — self-healing 65 class | **Healenium** + auto-waiting/locator ngữ nghĩa của Playwright |
| Quản lý test case | **Kiwi TCMS** hoặc **Qase** |
| `ui/` Angular — soạn thảo no-code, recorder, mirror thiết bị | **Không có bản thay thế** — soạn bằng VS Code/RobotCode. Đây là cái MẤT lớn nhất |

### 9.3. Năm giai đoạn (6–12 tháng-người)

1. **Phase 0 — Containment (3–5 tuần, vô điều kiện):** trùng Phase 0 mục 6 — dump+restore drill, tháo bom vendor (cert agent, telemetry, 2 scheduler), purge key DigiCert, xoay secret. *Không* nâng framework — đó là cái bẫy nuốt mất một năm.
2. **Phase 1 — Census (2–3 tuần):** chạy `docs/asset-census.sql` (đã commit kèm báo cáo này, tên bảng/cột đối chiếu schema thật) trên DB production. Biến "hệ có 224 verb" thành "estate của tôi dùng N verb, 6 verb phủ 80% step". Đếm luôn: step group, data-driven, if/loop, REST step, addon JAR (loại tài sản duy nhất **không có đường migrate tự động**), locator theo loại.
3. **Phase 2 — Chọn đích + spike đối kháng (5–7 tuần):** chọn stack theo census; tự tay dịch top-20 verb; port một suite 50 test THẬT; chạy song song với Testsigma 2 tuần, so pass/fail + flake + thời gian. Đồng thời **demo bề mặt soạn thảo cho chính người viết test**. Cổng go/no-go là *sự chấp nhận của người viết*, không phải độ chính xác bản dịch.
4. **Phase 3 — Viết translator (3–4 tháng):** ~5–8k LOC mới duy nhất. Input: XML backup của chính Testsigma (`XMLExportImportService` — 46 DTO, cỗ máy trích xuất vendor viết sẵn); mẫu tham khảo có sẵn trong repo: `TestStepImportService` + `ExternalImportNlpMappingService` (Testsigma từng viết importer *chiều vào* — translator là chiều ra của cùng pattern). Emit: elements → page object, test_data → data file, step group → keyword tái dùng, suite/plan → định nghĩa job CI. Verb không dịch được → stub TODO có cờ, không rơi im lặng.
5. **Phase 4–5 — Cutover từng workspace + nghỉ hưu (3–5 tháng, chồng lấn):** không bao giờ big-bang. Mỗi workspace: dịch → chạy song song 2–3 chu kỳ → diff → sửa đuôi → **đóng băng soạn thảo trong Testsigma** → cắt. Web-only ít addon đi trước, mobile-native đi cuối (215/586 dòng catalog). Kết quả cũ export sang ReportPortal/Allure hoặc giữ một instance read-only cách ly mạng để tra cứu audit. Cuối cùng: archive repo kèm tài liệu 224 verb.

### 9.4. Rủi ro chính & điều kiện thắng

- **Người viết test là ai — rủi ro giết dự án, và nó không phải kỹ thuật.** Giá trị cốt lõi của Testsigma là non-coder viết test. Nếu họ không chấp nhận keyword syntax (Robot/CodeceptJS), Harvest chết vì con người → quay về containment, không phải rewrite. Giải quyết trong 90 ngày đầu bằng demo thật.
- **Mobile-native là nơi ước lượng vỡ** (dịch đắt nhất) — census quyết định.
- **Flake-rate delta khi cutover:** engine cũ có hành vi ngầm (retry 1 lần khi `StaleElementReference`, fallback JS `innerText`…) mà test đã "quen" — test dịch xong sẽ fail *khác kiểu*; cần ngân sách chỉnh đuôi và kỳ vọng đúng từ stakeholder.
- **Nửa đường đứt gánh là kết cục tệ nhất** (gánh 2 hệ song song vĩnh viễn): ép deadline decommission theo lịch, đóng băng soạn thảo theo từng workspace ngay khi cắt.
- **Chi phí để biết có nên đi hay không chỉ là ~2 tháng** (Phase 1–2) — Phase 0 kiểu gì cũng phải làm. Không có cam kết không thể đảo ngược nào trước cổng Phase 2.

### 9.5. Kết quả census (27-08-2026, DB production) — **GO**

Cả ba điều kiện của cổng dữ liệu đều bật xanh:

| Điều kiện cổng | Kết quả thật |
|---|---|
| Web-only? | **99,6%** — 52.990/54.262 step là WebApplication; mobile tổng cộng 217 step (~20 case thử nghiệm — re-record nhanh hơn dịch) |
| Addon? | **0 addon cài đặt** — hạng mục duy nhất không migrate tự động được thì trống trơn |
| Quy mô/độ tập trung? | **1 workspace thật duy nhất** ("Web workspace (Live)": 3.111 case / 52.900 step / 2.159 element, sửa lần cuối 26-08-2026 — estate đang sống) |

Chi tiết đọc được từ số liệu:

- **~80 verb thực dùng** trên 586 câu catalog; click + enter = 55,7% tổng step; **9 verb phủ 80%**; **~35 verb phủ 99%** — translator chỉ cần chừng đó, đuôi ~45 verb dùng 1–2 lần thì sửa tay.
- **~4.700 step think/wait thủ công (8,7%)** — auto-wait của Playwright xóa gần hết: bản dịch gọn hơn bản gốc.
- **Construct trung tâm: `pre_requisite` — 2.904/3.143 case (92%)** dùng chuỗi case-gọi-case → dịch thành setup function/fixture dùng chung; cần đo độ sâu chuỗi (SQL bổ sung mục 7 trong `asset-census.sql`).
- Step group: 51 group / 625 điểm gọi → 51 hàm dùng chung. Conditional 716 + forloop 524 → if/for thường. (Đính chính: query `for_loop_*` ra 0 vì loop ở estate này đi qua verb NLP "forloop" — histogram bắt được.)
- Data-driven: 214 case + 149 profile → parameterized test. REST: 6 step — không đáng kể.
- Locator: csspath ~1.500, xpath ~550, id 87, dynamic 68 → port nguyên vẹn thành page object.
- ⚠️ Bất thường cần soi: **7.344 suite / 7.112 plan cho 3.143 case** — gần chắc sinh tự động (per-run/API). Đừng dịch 7k plan; đếm plan thật bằng SQL bổ sung mục 8.

**Ước lượng lại: ~4–6 tháng-người** (từ dải 6–12 — phần kéo rộng là mobile + addon, cả hai = 0), suite đầu chạy song song sau ~6–8 tuần. Cutover theo suite/tag trong chính workspace duy nhất (estate đang sửa hằng ngày → đóng băng theo lát cắt nhỏ). Phase 0 (tháo bom vendor + mirror bucket) vẫn đi trước.

**Cổng còn lại duy nhất là con người:** dev/SDET viết test → **Playwright + TypeScript**; QA quen keyword → **Robot Framework** hoặc **CodeceptJS**; QA thuần no-code không rời được UI → dừng ở lộ trình ổn định (mục 6), Harvest chết vì adoption.

### 9.6. Phán quyết cuối — cổng con người trả lời: QA thuần no-code → chọn đường D

Maintainer xác nhận người viết test hằng ngày là **QA thuần no-code, cần UI kéo-thả** → Harvest sang stack code bị loại vì adoption (đúng rủi ro số 1 đã dự báo). Bốn đường còn lại:

- **A — Ổn định platform (mặc định), nay rẻ hơn nhờ census:** 99,6% web → **bỏ hẳn toàn bộ mobile** (không chỉ iOS): đóng băng/xóa stack usbmuxd–adb–Appium của agent; installer chỉ còn cần JRE + nginx (đều tải được từ nguồn chính chủ) → **bom bucket S3 gần như tự tháo ngòi**. Ước lượng giảm còn ~12–15 tháng-người rải ~2 năm.
- **B — Mua đường thoát no-code thương mại:** Testsigma Cloud bản thương mại (cùng UI, import tự nhiên nhất — công ty vendor vẫn sống, chỉ bản OSS bị bỏ), TestRigor, Katalon, Mabl. Đổi công lấy license + quay lại vendor lock-in.
- **C — Demo 2 tuần kiểm chứng giả định no-code** với 2–3 QA thật trên ~20 test dịch sẵn, trước khi chốt.
- **★ D — Hướng được chọn: NÂNG CẤP CÓ AI — giữ platform + lớp Claude qua MCP có xác thực.** Giữ UI kéo-thả (fallback khi hết token + nơi review), thêm MCP server bọc REST API để Claude soạn/sửa/triage test. AI là lớp cộng thêm, không phải phụ thuộc.

**Thiết kế đường D:**

1. **Vì sao kiến trúc này hợp AI bất thường:** (a) catalog 586 câu = vocabulary đóng — MCP server validate mọi step Claude sinh so với `natural_text_actions` (đúng câu mẫu, placeholder trỏ element/test-data thật) trước khi ghi DB → không có step ảo; (b) schema sẵn workflow nháp (`draft_at`/`ready_at`) → Claude luôn tạo DRAFT, QA review trong UI rồi promote; (c) nền auth API-key có sẵn (`APIAuthenticationFilter`) — nhưng CRUD case/step đang sau cookie-JWT UI → cần mở surface `api/v1` PAT-authenticated (~1–2 tuần, trùng hạng mục security floor + OpenAPI).
2. **Sơ đồ:** QA/dev dùng Claude (claude.ai Team / Claude Desktop / Claude Code) → MCP server (Node/TypeScript, ~12 tool: tìm/đọc case, tạo case nháp, thêm/sửa step có validate, quản lý element, chạy plan, đọc kết quả + screenshot fail, tra catalog verb) → REST Testsigma (API key giữ server-side) → MySQL. Auth 2 lớp: user ↔ MCP theo spec MCP (OAuth nếu remote / stdio local); MCP ↔ Testsigma bằng API key không lộ ra client.
3. **Use case đáng tiền nhất cho solo maintainer:** bảo trì estate — triage kết quả chạy đêm (đọc failure + screenshot, đề xuất sửa locator thành draft), gộp step trùng thành step group, dọn 2.159 element. Chạy batch/định kỳ với ngân sách token cố định; hết ngân sách → QA làm tay như cũ, không bị động.
4. **Công sức:** MCP server v1 ~2–4 tuần + mở API ~1–2 tuần → **~1–1,5 tháng-người**, làm ngay sau Phase 0, song song lộ trình nâng framework (MCP là process Node riêng, không đụng code Java). Model mặc định: Claude Opus 5 (`claude-opus-5`, $5/$25 per MTok); khối lượng lớn dùng Batch API (−50%). Tiên quyết: Phase 0 xong (CSRF + xoay API key mặc định) — không đấu AI vào server còn mở toang.

### 9.7. Đường E — Rewrite lõi theo census (bổ sung 27-08-2026)

> Bối cảnh: maintainer đặt lại câu hỏi rewrite với 2 điều kiện mới: chỉ rewrite **luồng nghiệp vụ cốt lõi** (không parity), tích hợp cởi mở hơn, và hệ cũ được phép chạy nội bộ tạm ~6 tháng làm fallback.

**Vì sao đây KHÔNG phải phương án đã bị loại:** thứ bị loại là rewrite-để-ngang-bằng (218 endpoint, 4 nền tảng, recorder, addon, device lab — 8–15 năm-người). Census chứng minh phần *thực dùng* chỉ là: web-only, ~35 verb, 1 workspace, 0 addon → rewrite đúng phần đó là xây một sản phẩm nội bộ nhỏ **~25–30k LOC TypeScript** thay cho 178k LOC — trong tầm với một người có 6–9 tháng.

**Bản đồ luồng cốt lõi → thiết kế mới (một ngôn ngữ TS cho tất cả):**

| Luồng | Hệ cũ | Thiết kế mới |
|---|---|---|
| Soạn test | contentEditable 2.310 dòng + execCommand; catalog 586 câu → reflection | Step-builder có cấu trúc (autocomplete + element picker); catalog ~35 verb là data, validate khi lưu; QA vẫn no-code |
| Chạy test | God class 1.570 dòng → automator JAR / agent poll 3s → Selenium + driver manager | API → BullMQ → **worker container Playwright**; không agent, không driver manager; auto-wait xóa ~4.700 step think/wait |
| Kết quả | 5 tầng bảng + UI polling | Bảng gọn + SSE push + screenshot object storage + **trace Playwright** mỗi run |
| Element | 2.159 locator, tạo bằng recorder | Import nguyên vẹn; picker dựa Playwright codegen (tùy QA có phụ thuộc recorder không) |
| Data-driven | 149 profile + XLS (POI 3.15) | Giữ khái niệm; exceljs; 214 case → parameterized |
| Prereq/group/if/loop | Ngữ nghĩa ngầm, không tài liệu (92% case dùng prereq) | Ngữ nghĩa tường minh, log rõ; 51 group = hàm tái dùng |
| Lập lịch | @Scheduled poll + thread pool vô hạn | BullMQ repeatable jobs |
| Tích hợp ("cởi mở") | 18 class cứng + addon JAR (RCE) + vendor SaaS | **OpenAPI ngày 1 + webhooks + MCP native + PAT**; mở rộng bằng HTTP, không bao giờ bằng nạp JAR |
| Auth | JWT cookie + CSRF off + secrets plaintext | Session + Google OAuth, secrets qua env, CSRF bật |

**Kế hoạch 6–9 tháng:** (0) tuần 1–3: **Phase-0-lite hệ cũ bắt buộc** (cert, telemetry, scheduler, backup — fallback chỉ tồn tại nếu bom đã tháo) + schema mới + OpenAPI v0 + **prototype step-builder cho QA thử ngay tuần 3** (cổng adoption đi trước engine); (1) tháng 1–2: engine (~35 verb trên Playwright, parser theo cột `data` của catalog) + importer 15 bảng — **cột mốc go/no-go: chạy 1 suite thật từ data thật ở CLI, diff với hệ cũ; trượt quá 1 tháng → quay về A+D, mất ~2 tháng**; (2) tháng 3–4: API + UI authoring ~10–15 màn; (3) tháng 5: scheduling + webhooks + MCP native (đường D nhập vào đây); (4) tháng 6–9: parallel-run, diff, cutover theo suite, hệ cũ read-only giữ lịch sử.

**So sánh chốt:** A+D = 12–15 tháng-người rải 2 năm, rủi ro thấp, Java ở lại; E = ~7–10 tháng-người dồn 6–9 tháng, rủi ro solo-slip + adoption step-builder + tái hiện hành vi ngầm engine cũ, kết quả là codebase TS ~25–30k LOC của chính mình, MCP-native, Java nghỉ hưu. Với bề mặt thực dùng ~5% + fallback 6 tháng + cổng thoát tháng 2, E là **canh bạc hợp lý có cửa thoát**, điều kiện: scope sắt máu (không mobile/addon/recorder-v1/multi-version), prototype QA tuần 3, tôn trọng cổng tháng 2.

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

Kiểm toán thực hiện bằng 2 đợt workflow, tổng 21 agent. **Đợt 1 (mục 1–7):** 7 agent trinh sát song song (server, ui, automator, agent+launcher, hợp đồng liên module, build/deploy, nợ kỹ thuật & bảo mật), 1 agent kiểm chứng độc lập (phát hiện 6 khoảng trống — trong đó có 2 scheduler di-cư vĩnh viễn cả 7 báo cáo bỏ sót — và sửa 2 số liệu sai: 65 migration chứ không phải 157; đếm bổ sung 61 bảng), 3 agent bảo vệ 3 chiến lược đối lập, 1 vòng phán quyết chấm chéo. **Đợt 2 (mục 8 — phương án Go):** 3 agent kiểm kê mức khóa JVM trong repo (đếm từng call site reflection/classloading, từng thư viện Java-only), 2 agent nghiên cứu hệ sinh thái Go 2026 (kiểm chứng nguồn và ngày release của chromedp/go-rod/tebeka-selenium/playwright-go/go-ios…), 3 agent bảo vệ 3 kịch bản Go đối lập, 1 vòng phán quyết có tái xác minh bằng chứng — gồm cả kiểm tra trực tiếp bucket S3 vendor còn trả HTTP 200. Mọi con số then chốt trong báo cáo đều được xác minh trực tiếp trên mã nguồn tại commit `a6155d0`.
