-- ============================================================================
-- ASSET CENSUS — bộ SQL quyết định phương án thoát-Java (Harvest & Replace)
-- Xem docs/ARCHITECTURE_AUDIT.md, mục 8-9.
--
-- Chạy READ-ONLY trên DB production (testsigma_opensource), MySQL 5.7/8.0.
-- Mục tiêu: biến "hệ thống có 586 câu lệnh / 224 verb" thành
-- "estate của TÔI thực dùng N verb, M% là web, X addon, Y construct khó dịch"
-- — con số này quyết định chi phí dịch chuyển sang Robot Framework/CodeceptJS.
--
-- Tên bảng/cột đã đối chiếu với schema bootstrap tại commit a6155d0.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. TỔNG QUAN ESTATE — quy mô thô
-- ----------------------------------------------------------------------------
SELECT 'workspaces'            AS what, COUNT(*) AS n FROM workspaces
UNION ALL SELECT 'workspace_versions',  COUNT(*) FROM workspace_versions
UNION ALL SELECT 'test_cases (song)',   COUNT(*) FROM test_cases WHERE deleted = 0
UNION ALL SELECT 'test_cases (da xoa)', COUNT(*) FROM test_cases WHERE deleted = 1
UNION ALL SELECT 'step_groups',         COUNT(*) FROM test_cases WHERE deleted = 0 AND is_step_group = 1
UNION ALL SELECT 'test_cases data-driven', COUNT(*) FROM test_cases WHERE deleted = 0 AND is_data_driven = 1
UNION ALL SELECT 'test_steps',          COUNT(*) FROM test_steps
UNION ALL SELECT 'elements',            COUNT(*) FROM elements
UNION ALL SELECT 'test_data profiles',  COUNT(*) FROM test_data
UNION ALL SELECT 'test_suites',         COUNT(*) FROM test_suites
UNION ALL SELECT 'test_plans',          COUNT(*) FROM test_plans
UNION ALL SELECT 'rest_step_details',   COUNT(*) FROM rest_step_details
UNION ALL SELECT 'addons cai dat',      COUNT(*) FROM addons;

-- ----------------------------------------------------------------------------
-- 1. HISTOGRAM VERB — câu truy vấn quan trọng nhất toàn dự án.
--    Verb nào THỰC SỰ được dùng, bao nhiêu lần, ở loại workspace nào.
--    (chỉ tính step của test case còn sống, không tính step group lồng nhau 2 lần)
-- ----------------------------------------------------------------------------
SELECT
  w.type                      AS workspace_type,
  nta.display_name            AS verb,
  nta.snippet_class,
  COUNT(*)                    AS so_step_dung,
  COUNT(DISTINCT tc.id)       AS so_test_case_dung
FROM test_steps ts
JOIN test_cases tc         ON tc.id = ts.test_case_id AND tc.deleted = 0
JOIN workspace_versions wv ON wv.id = tc.workspace_version_id
JOIN workspaces w          ON w.id = wv.workspace_id
JOIN natural_text_actions nta ON nta.id = ts.natural_text_action_id
GROUP BY w.type, nta.display_name, nta.snippet_class
ORDER BY so_step_dung DESC;

-- 1b. Đường cong tích lũy: bao nhiêu verb phủ 80% số step?
--     (chạy query 1, cộng dồn so_step_dung từ trên xuống — hoặc dùng bản MySQL 8:)
SELECT verb, so_step_dung,
       ROUND(100 * SUM(so_step_dung) OVER (ORDER BY so_step_dung DESC)
             / SUM(so_step_dung) OVER (), 1) AS phan_tram_tich_luy
FROM (
  SELECT nta.display_name AS verb, COUNT(*) AS so_step_dung
  FROM test_steps ts
  JOIN test_cases tc ON tc.id = ts.test_case_id AND tc.deleted = 0
  JOIN natural_text_actions nta ON nta.id = ts.natural_text_action_id
  GROUP BY nta.display_name
) t ORDER BY so_step_dung DESC;

-- ----------------------------------------------------------------------------
-- 2. CÁC CONSTRUCT KHÓ DỊCH HƠN VERB — mỗi loại là một hạng mục
--    phải thiết kế riêng trong translator (if/loop/step-group/data-driven/REST).
-- ----------------------------------------------------------------------------
SELECT 'step co dieu kien (condition_type)' AS construct, COUNT(*) AS n
  FROM test_steps WHERE condition_type IS NOT NULL
UNION ALL SELECT 'step for-loop', COUNT(*)
  FROM test_steps WHERE for_loop_start_index IS NOT NULL OR for_loop_test_data_id IS NOT NULL
UNION ALL SELECT 'step goi step-group', COUNT(*)
  FROM test_steps WHERE step_group_id IS NOT NULL
UNION ALL SELECT 'step REST API', COUNT(*)
  FROM rest_step_details
UNION ALL SELECT 'step dung addon action', COUNT(*)
  FROM test_steps WHERE addon_action_id IS NOT NULL
UNION ALL SELECT 'step dung addon test-data-function', COUNT(*)
  FROM test_steps WHERE addon_plugin_tdf_data IS NOT NULL
UNION ALL SELECT 'test_case co pre_requisite', COUNT(*)
  FROM test_cases WHERE deleted = 0 AND pre_requisite IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 3. ADDON — loại tài sản DUY NHẤT không có đường migrate tự động
--    (JAR do khách tự build trên SDK beta của vendor; nhiều = chi phí tăng vọt)
-- ----------------------------------------------------------------------------
SELECT a.id, a.name, a.version, a.status,
       COUNT(DISTINCT anta.id) AS so_action_dang_ky,
       COUNT(DISTINCT ts.id)   AS so_step_thuc_dung
FROM addons a
LEFT JOIN addon_natural_text_actions anta ON anta.addon_id = a.id
LEFT JOIN test_steps ts ON ts.addon_action_id = anta.id
GROUP BY a.id, a.name, a.version, a.status
ORDER BY so_step_thuc_dung DESC;

-- ----------------------------------------------------------------------------
-- 4. ELEMENTS / LOCATOR — tài sản chuyển thẳng sang page-object, gần như free.
--    locator_type nào chiếm đa số? bao nhiêu là dynamic (khó port hơn)?
-- ----------------------------------------------------------------------------
SELECT locator_type, create_type, is_dynamic, COUNT(*) AS n
FROM elements
GROUP BY locator_type, create_type, is_dynamic
ORDER BY n DESC;

-- ----------------------------------------------------------------------------
-- 5. BẢN ĐỒ CUTOVER THEO WORKSPACE — xếp thứ tự chuyển đổi dễ-trước-khó-sau
--    (web-only, ít addon, ít conditional đi trước; mobile-native đi cuối)
-- ----------------------------------------------------------------------------
SELECT
  w.id, w.name, w.type,
  COUNT(DISTINCT tc.id)                                          AS so_test_case,
  COUNT(ts.id)                                                   AS so_step,
  SUM(ts.condition_type IS NOT NULL)                             AS step_dieu_kien,
  SUM(ts.step_group_id IS NOT NULL)                              AS step_goi_group,
  SUM(ts.addon_action_id IS NOT NULL)                            AS step_addon,
  MAX(tc.updated_date)                                           AS lan_sua_cuoi
FROM workspaces w
JOIN workspace_versions wv ON wv.workspace_id = w.id
JOIN test_cases tc         ON tc.workspace_version_id = wv.id AND tc.deleted = 0
LEFT JOIN test_steps ts    ON ts.test_case_id = tc.id
WHERE w.is_demo = 0
GROUP BY w.id, w.name, w.type
ORDER BY step_addon ASC, step_dieu_kien ASC, so_step ASC;

-- ----------------------------------------------------------------------------
-- 6. TỶ TRỌNG MOBILE-NATIVE — nếu lớn, chi phí Harvest tăng mạnh
--    (215/586 dòng catalog là Android/iOS native; đây là phần dịch đắt nhất)
-- ----------------------------------------------------------------------------
SELECT w.type,
       COUNT(ts.id)                                       AS so_step,
       ROUND(100 * COUNT(ts.id) / (SELECT COUNT(*) FROM test_steps ts2
         JOIN test_cases tc2 ON tc2.id = ts2.test_case_id AND tc2.deleted = 0), 1) AS phan_tram
FROM test_steps ts
JOIN test_cases tc         ON tc.id = ts.test_case_id AND tc.deleted = 0
JOIN workspace_versions wv ON wv.id = tc.workspace_version_id
JOIN workspaces w          ON w.id = wv.workspace_id
GROUP BY w.type ORDER BY so_step DESC;

-- ============================================================================
-- ĐỌC KẾT QUẢ:
--  * Ít verb thực dùng (≤ ~40), phần trăm web áp đảo, addon ≈ 0, ít conditional
--      → Harvest & Replace ở CẬN DƯỚI (~6 tháng-người): dịch sang
--        Robot Framework / CodeceptJS là con đường thoát Java rẻ nhất.
--  * Nhiều mobile-native, nhiều addon JAR, nhiều if/loop/step-group
--      → chi phí dịch vượt 12 tháng-người: cân nhắc giữ platform (lộ trình mục 6)
--        hoặc chỉ dịch các workspace web trước.
--  * Song song với SQL này: demo Robot Framework/CodeceptJS cho NGƯỜI VIẾT TEST
--    THẬT — nếu họ không chấp nhận bỏ UI no-code/recorder, Harvest chết vì
--    con người chứ không phải kỹ thuật.
-- ============================================================================
