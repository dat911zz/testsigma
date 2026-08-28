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
  const org = await t.db.execute(
    sql`INSERT INTO organizations (name, slug) VALUES ('Acme','acme') RETURNING id`,
  );
  const orgId = String(org.rows[0]?.["id"]);
  const team = await t.db.execute(
    sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},'A','a') RETURNING id`,
  );
  teamId = String(team.rows[0]?.["id"]);
  const p = await t.db.execute(
    sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamId},'P','p') RETURNING id`,
  );
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

/**
 * drizzle bọc lỗi driver trong `DrizzleQueryError` có message = "Failed query: <SQL>"
 * — NGUYÊN VĂN câu SQL nằm trong message. Hệ quả: `rejects.toThrow(/codec/i)` XANH
 * kể cả khi bảng chưa tồn tại (quan sát thật ở bước ĐỎ của task này: 2/9 test xanh
 * trước khi có migration). Muốn khẳng định đúng ràng buộc nào đã bắn thì phải bóc
 * `cause` ra đọc `code` + `constraint` của Postgres.
 */
type PgError = { readonly code: string; readonly constraint?: string; readonly message: string };

function isPgError(e: unknown): e is PgError {
  return typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string";
}

async function pgErrorOf(run: () => Promise<unknown>): Promise<PgError> {
  let thrown: unknown;
  try {
    await run();
  } catch (e) {
    thrown = e;
  }
  if (thrown === undefined) throw new Error("Câu lệnh đáng lẽ bị từ chối nhưng đã chạy thành công");
  let cur: unknown = thrown;
  for (let depth = 0; depth < 5 && cur !== undefined && cur !== null; depth += 1) {
    if (isPgError(cur)) return cur;
    cur = (cur as { cause?: unknown }).cause;
  }
  throw new Error(`Không bóc được lỗi Postgres từ: ${String(thrown)}`);
}

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
    const err = await pgErrorOf(() => t.db.execute(ins));
    expect(err.code).toBe("23505"); // unique_violation
    expect(err.constraint).toBe("aut_case_revisions_no_unique");
  });

  it("CHECK chặn codec lạ", async () => {
    const err = await pgErrorOf(() =>
      t.db.execute(sql`
        INSERT INTO aut_case_revisions
          (team_id, case_id, revision_no, case_version, codec, payload, payload_size, payload_sha256)
        VALUES (${teamId},${caseId},1,1,'brotli','\\x00'::bytea,10,repeat('a',64))`),
    );
    expect(err.code).toBe("23514"); // check_violation
    expect(err.constraint).toBe("aut_case_revisions_codec_known");
  });

  it("CHECK chặn sha256 không phải 64 hex", async () => {
    const err = await pgErrorOf(() =>
      t.db.execute(sql`
        INSERT INTO aut_case_revisions
          (team_id, case_id, revision_no, case_version, codec, payload, payload_size, payload_sha256)
        VALUES (${teamId},${caseId},1,1,'raw','\\x00'::bytea,10,'khong-phai-hash')`),
    );
    expect(err.code).toBe("23514");
    expect(err.constraint).toBe("aut_case_revisions_sha256_hex");
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
