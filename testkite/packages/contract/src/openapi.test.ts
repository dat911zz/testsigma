import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, OPENAPI_SCHEMA_NAMES, serializeOpenApiDocument } from "./openapi.js";
import { ROUTES, pathParamNames } from "./routes/index.js";

describe("buildOpenApiDocument", () => {
  it("là OpenAPI 3.1.0", () => {
    expect(buildOpenApiDocument().openapi).toBe("3.1.0");
  });

  it("đăng ký đủ mọi schema công bố", () => {
    const schemas = buildOpenApiDocument().components?.schemas ?? {};
    for (const name of OPENAPI_SCHEMA_NAMES) expect(Object.keys(schemas)).toContain(name);
  });

  it("literal dịch thành `const` — idiom 3.1, không phải enum 1 phần tử của 3.0", () => {
    const step = buildOpenApiDocument().components?.schemas?.["AuthoredStep"] as {
      oneOf: { properties: { kind: { const?: string; enum?: string[] } } }[];
    };
    const kinds = step.oneOf.map((b) => b.properties.kind.const);
    expect(kinds).toContain("action");
    expect(step.oneOf[0]?.properties.kind.enum).toBeUndefined();
  });

  it("children của block trỏ ngược về chính AuthoredStep ($ref đệ quy)", () => {
    const step = buildOpenApiDocument().components?.schemas?.["AuthoredStep"] as {
      oneOf: { properties: Record<string, { items?: { $ref?: string } }> }[];
    };
    const withChildren = step.oneOf.find((b) => b.properties["children"] !== undefined);
    expect(withChildren?.properties["children"]?.items?.$ref).toBe("#/components/schemas/AuthoredStep");
  });

  it("mọi $ref trong tài liệu đều trỏ tới một schema có thật", () => {
    const doc = buildOpenApiDocument();
    const names = new Set(Object.keys(doc.components?.schemas ?? {}));
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(names.has(ref as string)).toBe(true);
  });
});

describe("paths OpenAPI", () => {
  it("mọi route trong ROUTES có mặt trong document", () => {
    const doc = buildOpenApiDocument();
    for (const r of ROUTES) {
      const item = doc.paths?.[r.path] as Record<string, { operationId?: string }> | undefined;
      expect(item, `thiếu path ${r.path}`).toBeDefined();
      expect(item?.[r.method]?.operationId).toBe(r.operationId);
    }
  });

  it("path param sinh ra parameter format uuid — đầu vào của bộ test L3", () => {
    const doc = buildOpenApiDocument();
    const withParams = ROUTES.filter((r) => pathParamNames(r.path).length > 0);
    expect(withParams.length).toBeGreaterThan(0);
    for (const r of withParams) {
      const op = (
        doc.paths?.[r.path] as Record<string, { parameters?: { in: string; schema?: { format?: string } }[] }>
      )[r.method];
      const pathParams = (op?.parameters ?? []).filter((p) => p.in === "path");
      expect(pathParams.length).toBe(pathParamNames(r.path).length);
      for (const p of pathParams) expect(p.schema?.format).toBe("uuid");
    }
  });

  it("route auth=required khai securitySchemes bearer", () => {
    const doc = buildOpenApiDocument();
    expect(doc.components?.securitySchemes?.["bearerAuth"]).toBeDefined();
    const secured = ROUTES.find((r) => r.auth === "required");
    const op = (doc.paths?.[secured?.path ?? ""] as Record<string, { security?: unknown[] }>)[secured?.method ?? "get"];
    expect(op?.security).toEqual([{ bearerAuth: [] }]);
  });
});

describe("serializeOpenApiDocument", () => {
  it("sinh 2 lần ra byte GIỐNG HỆT — điều kiện sống của gate drift", () => {
    expect(serializeOpenApiDocument()).toBe(serializeOpenApiDocument());
  });

  it("kết thúc bằng newline — POSIX, tránh diff giả ở dòng cuối", () => {
    expect(serializeOpenApiDocument().endsWith("\n")).toBe(true);
  });
});
