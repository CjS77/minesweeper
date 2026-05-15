/**
 * Helpers for classifying and extracting information from Anthropic SDK errors.
 *
 * The SDK error shape is not guaranteed to be stable, so `isApiLimitError`
 * uses multiple signals (numeric status code, error name, message text) to
 * identify rate-limit and overload responses robustly. `resumeTimeFromError`
 * extracts an ISO-8601 reset instant when the error message contains one, so
 * the supervisor can schedule a back-off rather than immediately re-queueing.
 */

/** Numeric HTTP status codes that indicate a transient API capacity limit. */
const LIMIT_STATUS_CODES = new Set([429, 529]);

/** Matches error names that signal rate limiting or server overload. */
const LIMIT_NAME_RE = /rate.?limit|overloaded/i;

/**
 * Matches message text that signals a capacity limit. Covers:
 *   - "429" / "529" bare status codes embedded in messages
 *   - "rate limit", "rate-limit", "rate_limit" variants
 *   - "overloaded" / "overload"
 *   - "usage limit", "hit your limit"
 *   - "resets in N" style countdown phrases
 */
const LIMIT_MESSAGE_RE = /\b(429|529)\b|rate[\s_-]?limit|overload|usage limit|hit your limit|resets? \d/i;

/**
 * Returns `true` when `err` is recognisable as a transient Anthropic API
 * rate-limit or overload error. Uses several independent signals so the
 * detection remains robust across SDK versions and error subtypes.
 */
export function isApiLimitError(err: unknown): boolean {
  if (err === null || err === undefined || typeof err === "string") return false;
  if (typeof err !== "object") return false;
  const e = err as Record<string, unknown>;

  const status = e["status"] ?? e["statusCode"];
  if (typeof status === "number" && LIMIT_STATUS_CODES.has(status)) return true;

  const name = typeof e["name"] === "string" ? e["name"] : "";
  if (LIMIT_NAME_RE.test(name)) return true;

  const message = typeof e["message"] === "string" ? e["message"] : "";
  if (LIMIT_MESSAGE_RE.test(message)) return true;

  return false;
}

/** Matches an ISO-8601 timestamp embedded in a string. */
const ISO_TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/;

/** Matches a Unix-epoch seconds value after a "retry-after" or "reset" keyword. */
const EPOCH_KEYWORD_RE = /(?:retry[-_]after|reset(?:s)?)[\s:=]+(\d{10,})/i;

/**
 * Best-effort extraction of a UTC ISO-8601 reset instant from an API limit
 * error. Returns a string suitable for `canResumeAt` if the message contains
 * an unambiguous timestamp; returns `null` otherwise.
 *
 * Deliberately does NOT parse localised wall-clock strings like
 * "resets 3:50pm (Europe/Lisbon)" — converting a 12-hour time plus IANA zone
 * with no date into an absolute UTC instant is fragile. `canResumeAt: null`
 * means "retry next poll cycle", which is safe.
 */
export function resumeTimeFromError(err: unknown): string | null {
  if (err === null || err === undefined || typeof err !== "object") return null;
  const message = (err as Record<string, unknown>)["message"];
  if (typeof message !== "string") return null;

  const isoMatch = ISO_TIMESTAMP_RE.exec(message);
  if (isoMatch) return isoMatch[0];

  const epochMatch = EPOCH_KEYWORD_RE.exec(message);
  if (epochMatch) {
    const epochMs = parseInt(epochMatch[1]!, 10) * 1000;
    return new Date(epochMs).toISOString();
  }

  return null;
}
