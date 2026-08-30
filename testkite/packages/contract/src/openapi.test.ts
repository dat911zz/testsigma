import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, OPENAPI_SCHEMA_NAMES, serializeOpenApiDocument } from "./openapi.js";
import { ROUTES, pathParamNames } from "./routes/index.js";

describe("buildOpenApiDocument", () => {
  it("is OpenAPI 3.1.0", () => {
    expect(buildOpenApiDocument().openapi).toBe("3.1.0");
  });

  it("registers every published schema", () => {
    const schemas = buildOpenApiDocument().components?.schemas ?? {};
    for (const name of OPENAPI_SCHEMA_NAMES) expect(Object.keys(schemas)).toContain(name);
  });

  it("translates a literal to `const` — the 3.1 idiom, not 3.0's single-value enum", () => {
    const step = buildOpenApiDocument().components?.schemas?.["AuthoredStep"] as {
      oneOf: { properties: { kind: { const?: string; enum?: string[] } } }[];
    };
    const kinds = step.oneOf.map((b) => b.properties.kind.const);
    expect(kinds).toContain("action");
    expect(step.oneOf[0]?.properties.kind.enum).toBeUndefined();
  });

  it("a block's children point back to AuthoredStep itself (recursive $ref)", () => {
    const step = buildOpenApiDocument().components?.schemas?.["AuthoredStep"] as {
      oneOf: { properties: Record<string, { items?: { $ref?: string } }> }[];
    };
    const withChildren = step.oneOf.find((b) => b.properties["children"] !== undefined);
    expect(withChildren?.properties["children"]?.items?.$ref).toBe("#/components/schemas/AuthoredStep");
  });

  it("every $ref in the document points to a real schema", () => {
    const doc = buildOpenApiDocument();
    const names = new Set(Object.keys(doc.components?.schemas ?? {}));
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(names.has(ref as string)).toBe(true);
  });
});

describe("OpenAPI paths", () => {
  it("every route in ROUTES is present in the document", () => {
    const doc = buildOpenApiDocument();
    for (const r of ROUTES) {
      const item = doc.paths?.[r.path] as Record<string, { operationId?: string }> | undefined;
      expect(item, `missing path ${r.path}`).toBeDefined();
      expect(item?.[r.method]?.operationId).toBe(r.operationId);
    }
  });

  it("a path param generates a uuid-format parameter — input to the L3 test suite", () => {
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

  it("never publishes an /internal path — the fleet plane is not part of the tenant API", () => {
    // `/internal/fleet` is a SEPARATE Fastify app on a SEPARATE port, authenticated by fleet
    // credentials rather than tenant tokens. Publishing it would hand every reader of the
    // public spec the shape of the worker protocol, and would put it in front of any tooling
    // that generates clients (or ingress rules) from this document. INTERNAL_ROUTES is
    // deliberately not merged into ROUTES; this asserts the CONSEQUENCE, at the byte level the
    // CI gate greps, so the mistake fails on a developer's machine first.
    const doc = buildOpenApiDocument();
    const published = Object.keys(doc.paths ?? {}).filter((path) => path.startsWith("/internal"));
    expect(published, "the fleet plane escaped into the public OpenAPI document").toEqual([]);
    expect(serializeOpenApiDocument()).not.toContain('"/internal');
  });

  it("an auth=required route declares the bearer securityScheme", () => {
    const doc = buildOpenApiDocument();
    expect(doc.components?.securitySchemes?.["bearerAuth"]).toBeDefined();
    const secured = ROUTES.find((r) => r.auth === "required");
    const op = (doc.paths?.[secured?.path ?? ""] as Record<string, { security?: unknown[] }>)[secured?.method ?? "get"];
    expect(op?.security).toEqual([{ bearerAuth: [] }]);
  });
});

describe("serializeOpenApiDocument", () => {
  it("produces IDENTICAL bytes on two runs — the drift gate's life condition", () => {
    expect(serializeOpenApiDocument()).toBe(serializeOpenApiDocument());
  });

  it("ends with a newline — POSIX, avoids a fake diff on the last line", () => {
    expect(serializeOpenApiDocument().endsWith("\n")).toBe(true);
  });
});
