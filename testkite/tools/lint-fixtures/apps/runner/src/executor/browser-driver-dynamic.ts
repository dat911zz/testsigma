/**
 * DELIBERATE VIOLATION: `await import("playwright-core")` ships the very same driver into the
 * very same file — the twin `no-restricted-syntax` selector has to see what
 * `no-restricted-imports` structurally cannot.
 */
export async function smuggle(): Promise<unknown> {
  const pw = await import("playwright-core");
  const scoped = await import("@playwright/test");
  return { pw, scoped };
}
