import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, OPENAPI_SCHEMA_NAMES, serializeOpenApiDocument } from "./openapi.js";

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

describe("serializeOpenApiDocument", () => {
  it("sinh 2 lần ra byte GIỐNG HỆT — điều kiện sống của gate drift", () => {
    expect(serializeOpenApiDocument()).toBe(serializeOpenApiDocument());
  });

  it("kết thúc bằng newline — POSIX, tránh diff giả ở dòng cuối", () => {
    expect(serializeOpenApiDocument().endsWith("\n")).toBe(true);
  });
});
