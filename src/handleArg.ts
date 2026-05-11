/**
 * Pure helpers for the positional argument to `minesweeper handle`. Lives
 * outside `cli.ts` so unit tests can import without triggering the
 * top-level `program.parseAsync(process.argv)` side effect.
 */

import type { WorkItemKind } from "./child/state.js";

export function parseIssueArg(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`invalid issue number: ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * Parse the positional argument to `minesweeper handle`. Supports two
 * forms so the daemon can address all three work-item kinds:
 *
 *   - `42`                           → `{ kind: "issue", number: 42 }`
 *   - `codeScanningAlert/42`         → `{ kind: "codeScanningAlert", number: 42 }`
 *   - `secretScanningAlert/13`       → `{ kind: "secretScanningAlert", number: 13 }`
 *
 * The bare-number form is the back-compat path for the legacy
 * `minesweeper handle <issue#>` invocation; anything else must use the
 * namespaced form.
 */
export function parseHandleArg(raw: string): { kind: WorkItemKind; number: number } {
  if (raw.includes("/")) {
    const [prefix, ...rest] = raw.split("/");
    const remainder = rest.join("/");
    if (prefix === "codeScanningAlert" || prefix === "secretScanningAlert") {
      return { kind: prefix, number: parseIssueArg(remainder) };
    }
    if (prefix === "issue") {
      return { kind: "issue", number: parseIssueArg(remainder) };
    }
    throw new Error(
      `invalid handle arg: ${JSON.stringify(raw)} — expected a bare number, ` +
        `\`codeScanningAlert/<N>\`, or \`secretScanningAlert/<N>\``,
    );
  }
  return { kind: "issue", number: parseIssueArg(raw) };
}
