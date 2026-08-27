/**
 * CompileInput snapshot — orchestration fetch sẵn, compiler KHÔNG I/O.
 * Phản chiếu ngữ nghĩa đã xác minh của hệ cũ (blueprint §2):
 * prereq = chuỗi case; step group = case có isStepGroup; loop chạy trên data profile.
 */

export type StepKind = "action" | "step_group" | "if" | "for" | "while" | "rest";

export interface AuthoredStep {
  readonly ordinal: number;
  readonly kind: StepKind;
  /** kind=action: op key trong verb-kit registry. */
  readonly verbOpKey?: string;
  readonly args?: Readonly<Record<string, string>>;
  /** kind=action: tên tham chiếu element (đã là id trong hệ mới). */
  readonly elementId?: string;
  /** kind=step_group: case (isStepGroup=true) được gọi. */
  readonly stepGroupCaseId?: string;
  /** kind=if: kết quả kỳ vọng của nhánh (["SUCCESS"] ...). */
  readonly conditionExpected?: readonly string[];
  /** kind=for: data profile cấp dữ liệu vòng lặp. */
  readonly loopDataProfileId?: string;
  /** kind=while: bắt buộc — không có là compile error. */
  readonly maxIterations?: number;
  /** Câu NLP hiển thị cho QA trong kết quả. */
  readonly renderedSentence: string;
  /** if/for/while: các step con. */
  readonly children?: readonly AuthoredStep[];
}

export interface AuthoredCase {
  readonly id: string;
  readonly revisionId: string;
  readonly name: string;
  readonly isStepGroup: boolean;
  readonly prereqCaseId?: string;
  /** data-driven: profile + số hàng đã fetch. */
  readonly dataProfileId?: string;
  readonly steps: readonly AuthoredStep[];
}

export interface ElementSnapshot {
  readonly id: string;
  readonly name: string;
  readonly status: "ready" | "pending_locator";
  readonly locators: readonly { readonly kind: string; readonly value: string }[];
}

export interface DataRow {
  readonly label: string;
  readonly expectedToFail: boolean;
  readonly values: Readonly<Record<string, string>>;
}

export interface DataProfileSnapshot {
  readonly id: string;
  readonly rows: readonly DataRow[];
}

export interface EnvSnapshot {
  readonly baseUrl: string;
  readonly vars: Readonly<Record<string, string>>;
  /** Tên secret hợp lệ — plan chỉ được chứa $secret:<name>, không bao giờ giá trị. */
  readonly secretNames: readonly string[];
}

export interface CompileSnapshot {
  readonly teamId: string;
  readonly projectId: string;
  /** Các case được yêu cầu chạy (root của chain). */
  readonly targetCaseIds: readonly string[];
  /** Toàn bộ case liên quan (kể cả prereq + step group), key theo id. */
  readonly cases: Readonly<Record<string, AuthoredCase>>;
  readonly elements: Readonly<Record<string, ElementSnapshot>>;
  readonly dataProfiles: Readonly<Record<string, DataProfileSnapshot>>;
  readonly env: EnvSnapshot;
}
