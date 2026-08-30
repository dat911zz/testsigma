/**
 * DELIBERATE VIOLATION: `await import()` is the same image, the same credential surface — the
 * dynamic form must be caught by the twin `no-restricted-syntax` selector.
 */
export async function smuggle(): Promise<unknown> {
  const core = await import("@testkite/core");
  const pg = await import("pg");
  return { core, pg };
}
