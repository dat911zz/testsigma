/**
 * @testkite/verb-kit — op registry: verb NLP → executable Playwright op.
 *
 * Replaces the old Testsigma Class.forName mechanism (586 lines of natural_text_actions
 * reflection by class name — errors only surfaced at runtime). Here: a verb is DATA,
 * an op is CODE, the compiler binds verb→op at compile-time and COLLECTS EVERY ERROR
 * before any browser starts.
 *
 * Production census: 35 verbs cover 99% of 52,900 steps. Ported by histogram:
 * click (15,485) → enter (13,691) → navigateTo (3,341) → ... (docs/asset-census.sql)
 */
import { z } from "zod";

/** A placeholder a verb can declare in its sentence. */
export type VerbParamKind = "element" | "test-data" | "attribute" | "raw";

export interface VerbParamSpec {
  readonly name: string;
  readonly kind: VerbParamKind;
  readonly required: boolean;
}

/** Op execution context — supplied by the worker; an op never creates its own browser/context. */
export interface OpContext {
  /** The Playwright Page of the current context (chromium-headless-shell). */
  readonly page: unknown; // TODO(M4): import type { Page } from "playwright-core"
  readonly stepTimeoutMs: number;
  readonly log: (msg: string) => void;
}

export interface OpResult {
  readonly ok: boolean;
  /** Set only when ok=false — becomes an AssertionFailure (verdict), not an infra error. */
  readonly failureMessage?: string;
}

/**
 * A verb's args schema: args is always a string→string map (the real value is resolved
 * by the worker at run time — a secret stays in the `$secret:<name>` form through the compiler).
 */
export type VerbArgsSchema = z.ZodType<Record<string, string>>;

export interface VerbDefinition {
  /** Stable op_key — action_catalog.op_key is validated against this registry at boot (fail-fast). */
  readonly opKey: string;
  /** Sample sentence shown to QA — a placeholder in curly braces, name matches `params[].name`. */
  readonly sentence: string;
  readonly params: readonly VerbParamSpec[];
  /**
   * Args contract for compiler phase 3 (`verb_args_invalid` catches it BEFORE the browser runs).
   * Deliberately optional: a verb can be registered before it has a schema — a missing schema
   * means "not checked yet", not "everything is valid" (the remaining 33 verbs get filled in
   * gradually at M4).
   */
  readonly argsSchema?: VerbArgsSchema;
  /** true if the op needs real layout (actionability) — documented for the audit engine. */
  readonly needsRendering: boolean;
  readonly execute: (ctx: OpContext, args: Record<string, string>) => Promise<OpResult>;
}

/** Result of validateArgs — COLLECTS every issue, no first-fail (compiler rule §4). */
export type ArgsValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly string[] };

const registry = new Map<string, VerbDefinition>();

export function registerVerb(def: VerbDefinition): void {
  if (registry.has(def.opKey)) throw new Error(`duplicate opKey: ${def.opKey}`);
  registry.set(def.opKey, def);
}

export function getVerb(opKey: string): VerbDefinition | undefined {
  return registry.get(opKey);
}

export function allVerbs(): readonly VerbDefinition[] {
  return [...registry.values()];
}

/**
 * Checks a step's args against the verb's schema — a PURE function, no I/O, usable
 * from the compiler. A verb with no argsSchema yet ⇒ ok (doesn't block a verb still being ported).
 */
export function validateArgs(opKey: string, args: Readonly<Record<string, string>>): ArgsValidation {
  const verb = registry.get(opKey);
  if (verb === undefined) return { ok: false, issues: [`opKey not in registry: ${opKey}`] };

  const schema = verb.argsSchema;
  if (schema === undefined) return { ok: true };

  const parsed = schema.safeParse(args);
  if (parsed.success) return { ok: true };

  return { ok: false, issues: parsed.error.issues.map(formatIssue) };
}

function formatIssue(issue: z.ZodIssue): string {
  const path = issue.path.join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}

/** Element/data reference: an empty string is an authoring error, not a "valid empty value". */
const requiredArg = z.string().min(1);

// ---------------------------------------------------------------------------
// The first 2 verbs (55.7% of total production steps) — a template for the remaining 33.
// TODO(M4): implement each op's body on Playwright + a golden-test engine (T2) per verb.
// ---------------------------------------------------------------------------

registerVerb({
  opKey: "web.click",
  sentence: "Click on {element}",
  params: [{ name: "element", kind: "element", required: true }],
  argsSchema: z.object({ element: requiredArg }),
  needsRendering: true, // actionability: visible + stable + receives-events + enabled
  execute: async () => {
    throw new Error("TODO(M4): implement on Playwright locator.click()");
  },
});

registerVerb({
  opKey: "web.enter",
  sentence: "Enter {value} in {element} field",
  params: [
    // kind=test-data: the value comes from a data profile/env; name = args KEY, must match argsSchema.
    { name: "value", kind: "test-data", required: true },
    { name: "element", kind: "element", required: true },
  ],
  argsSchema: z.object({ element: requiredArg, value: requiredArg }),
  needsRendering: true, // fill: visible + enabled + editable
  execute: async () => {
    throw new Error("TODO(M4): implement on Playwright locator.fill()");
  },
});
