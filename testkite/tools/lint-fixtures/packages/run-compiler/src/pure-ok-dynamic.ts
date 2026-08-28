/** VALID: the rule forbids the EXACT list of modules, not `import()` in general —
 * dynamically loading `node:crypto` is still pure computation. */
export async function hashOf(payload: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(payload).digest("hex");
}
