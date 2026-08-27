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

export const elementSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: elementStatusSchema,
  /** ≥1: element không locator không thể bind ở phase 4 — chặn tại biên API. */
  locators: z.array(locatorSchema).min(1),
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
