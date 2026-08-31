/**
 * One reading of a node fs error, shared by the two files that must tell "the thing I was reading
 * is gone" apart from "I could not read the thing".
 *
 * The distinction is the whole point of both call sites. `/proc/<pid>/statm` disappearing means
 * the process exited — a race the governance layer expects and absorbs. A cgroup file that exists
 * but refuses to be read means the mount, the permissions or the assumption behind them is broken,
 * and absorbing THAT is how a real kernel OOM gets reported as a healthy chain.
 */

/** The `code` of a node fs error ("ENOENT", "EACCES", "EISDIR", …), or null when it is not one. */
export function errnoOf(err: unknown): string | null {
  if (typeof err !== "object" || err === null || !("code" in err)) return null;
  const code: unknown = err.code;
  return typeof code === "string" ? code : null;
}
