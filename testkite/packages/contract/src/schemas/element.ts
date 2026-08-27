/**
 * DTO authoring-facing cho element. Soi gương `ElementSnapshot`
 * (packages/run-compiler/src/snapshot.ts) — compiler nhận đúng hình dạng này.
 *
 * `exactOptionalPropertyTypes: true`: mọi prop optional phải khai `?: T | undefined`,
 * nếu không phép gán từ `z.infer` sẽ hỏng lúc typecheck.
 */
import { z } from "zod";

/**
 * `kind` là chuỗi tự do có chủ đích: catalog locator còn mở tới M4
 * (fixture hiện dùng css | xpath | text | test-id). Đóng enum sớm = phá fixture.
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
     * Rỗng CHỈ hợp lệ khi `status = pending_locator` — đúng nghĩa "chưa chụp được"
     * (fixture err-element-pending-locator.json của compiler mang y hình dạng này).
     * `ready` mà không locator là lời hứa suông: phase 4 không bind nổi ⇒ chặn ở biên.
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
        message: "element status=ready phải có ít nhất 1 locator",
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
