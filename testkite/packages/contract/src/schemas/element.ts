/**
 * Authoring-facing DTO for an element. Mirrors `ElementSnapshot`
 * (packages/run-compiler/src/snapshot.ts) — the compiler expects exactly this shape.
 *
 * `exactOptionalPropertyTypes: true`: every optional prop must declare `?: T | undefined`,
 * otherwise an assignment from `z.infer` breaks at typecheck.
 */
import { z } from "zod";

/**
 * `kind` is deliberately a free-form string: the locator catalog stays open until M4
 * (fixtures currently use css | xpath | text | test-id). Closing the enum early would
 * break fixtures.
 */
export const locatorSchema = z.object({
  kind: z.string().min(1),
  value: z.string().min(1),
});

export const ELEMENT_STATUSES = ["ready", "pending_locator"] as const;
export const elementStatusSchema = z.enum(ELEMENT_STATUSES);

export const elementSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    status: elementStatusSchema,
    /**
     * Empty is valid ONLY when `status = pending_locator` — the exact meaning of
     * "not captured yet" (the compiler's err-element-pending-locator.json fixture
     * carries this exact shape). `ready` with no locator is an empty promise: phase 4
     * can't bind it ⇒ blocked at the boundary.
     */
    locators: z.array(locatorSchema),
  })
  .superRefine((element, ctx) => {
    if (element.status === "ready" && element.locators.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_small,
        minimum: 1,
        type: "array",
        inclusive: true,
        path: ["locators"],
        message: "element status=ready must have at least 1 locator",
      });
    }
  });

export interface LocatorDto {
  kind: string;
  value: string;
}

export type ElementStatusDto = (typeof ELEMENT_STATUSES)[number];

export interface ElementDto {
  id: string;
  name: string;
  status: ElementStatusDto;
  locators: LocatorDto[];
}
