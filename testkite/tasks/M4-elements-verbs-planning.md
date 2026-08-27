# M4 — Elements + Capture · 35 verb · TestData · Planning

> Căn cứ: blueprint §4 (verb registry, T2 golden), quyết định "element capture service" (kịch bản S1).

- [ ] elm_screens/elm_elements (+create_type, +pending_locator) + element FK trong steps
- [ ] **Element capture service** (lane interactive): POST /v1/element-capture-sessions —
      micro-job Playwright+CDP stream ứng viên locator (uniqueness/stability score) qua SSE
- [ ] POST /v1/element-candidates:verify — match-count/visibility/uniqueness, tính quota nhỏ
- [ ] **35 verb** port theo histogram census (click→enter→navigateTo→…), mỗi verb:
      op Playwright + zod args + **engine golden test (T2) trên headless-shell thật** + bảng ngữ nghĩa
      (tái đặc tả tường minh — KHÔNG port theo tên: verifyElementPresent cũ thực chất isDisplayed();
      IfElement VISIBLE cũ chỉ findElement)
- [ ] upload = setInputFiles (DOM-level, không đòi visibility — đã xác minh cả 2 stack)
- [ ] testdata: tdt_profiles/rows (expected_to_fail) + XLSX import (exceljs, streaming)
- [ ] planning: pln_suites/plans/run_targets/environments (**base_url BẮT BUỘC**, secret_refs)
      + schedules (BullMQ repeatable + jitter 0–15ph)
- [ ] Cổng health môi trường (compiler phase 7.5): probe base_url 3×/10s ⇒ verdict=blocked

**Exit:** compile + chạy thật một case 20 step dùng 10 verb phổ biến trên app demo; capture 1 element
qua picker và verify. T2 xanh cho toàn bộ verb đã port.
