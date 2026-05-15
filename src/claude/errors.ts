/**
 * Helpers for classifying and extracting information from Anthropic SDK errors.
 *
 * The SDK error shape is not guaranteed to be stable, so `isApiLimitError`
 * uses multiple signals (numeric status code, error name, message text) to
 * identify rate-limit and overload responses robustly. `resumeTimeFromError`
 * extracts an ISO-8601 reset instant when the error message contains one —
 * including ISO timestamps, Unix-epoch `retry-after` values, and localised
 * wall-clock strings like "resets at 3:50pm (Europe/Lisbon)" — so the
 * supervisor can schedule a back-off rather than immediately re-queueing.
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

/** Matches a Unix-epoch seconds value after a "retry-after" keyword. */
const RETRY_AFTER_RE = /retry[-_]after[\s:=]+(\d{10,})/i;

/** Matches a localised wall-clock reset time with IANA timezone, e.g. "resets at 3:50pm (Europe/Lisbon)". */
const WALL_CLOCK_RESET_RE = /resets?\s+at\s+(\d{1,2}:\d{2}(?:am|pm))\s+\(([\w/]+)\)/i;

/**
 * Converts a 12-hour wall-clock time string ("3:50pm") and IANA timezone name
 * into a UTC ISO-8601 instant for today's date in that zone. Returns `null` if
 * parsing fails or the timezone identifier is unrecognised.
 *
 * Uses the Intl pivot technique: treat the local time as a naive UTC value,
 * then measure the zone's UTC offset at that moment and subtract it.
 */
function parseWallClockToISO(time12: string, ianaZone: string): string | null {
  const timeMatch = /^(\d{1,2}):(\d{2})(am|pm)$/i.exec(time12.trim());
  if (!timeMatch) return null;

  let hours = parseInt(timeMatch[1]!, 10);
  const minutes = parseInt(timeMatch[2]!, 10);
  const ampm = timeMatch[3]!.toLowerCase();
  if (ampm === "pm" && hours !== 12) hours += 12;
  if (ampm === "am" && hours === 12) hours = 0;

  try {
    // Today's date string in the target timezone ("YYYY-MM-DD" from en-CA locale)
    const dateInTz = new Intl.DateTimeFormat("en-CA", { timeZone: ianaZone }).format(new Date());
    const hh = String(hours).padStart(2, "0");
    const mm = String(minutes).padStart(2, "0");
    const naiveMs = Date.parse(`${dateInTz}T${hh}:${mm}:00Z`);
    if (isNaN(naiveMs)) return null;

    // Format the naive pivot time in the target timezone to compute offset
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: ianaZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = Object.fromEntries(formatter.formatToParts(new Date(naiveMs)).map((p) => [p.type, p.value]));
    const displayedMs = Date.UTC(
      parseInt(parts["year"]!, 10),
      parseInt(parts["month"]!, 10) - 1,
      parseInt(parts["day"]!, 10),
      parseInt(parts["hour"]!, 10) % 24, // guard against Intl returning "24" for midnight
      parseInt(parts["minute"]!, 10),
      parseInt(parts["second"]!, 10),
    );
    return new Date(naiveMs - (displayedMs - naiveMs)).toISOString();
  } catch {
    return null;
  }
}

/**
 * Best-effort extraction of a UTC ISO-8601 reset instant from an API limit
 * error. Recognises ISO timestamps, Unix-epoch `retry-after` values, and
 * localised wall-clock strings like "resets at 3:50pm (Europe/Lisbon)".
 * Returns `null` when no parseable timestamp is found — `canResumeAt: null`
 * means "retry next poll cycle", which is always safe.
 */
export function resumeTimeFromError(err: unknown): string | null {
  if (err === null || err === undefined || typeof err !== "object") return null;
  const message = (err as Record<string, unknown>)["message"];
  if (typeof message !== "string") return null;

  const isoMatch = ISO_TIMESTAMP_RE.exec(message);
  if (isoMatch) return isoMatch[0];

  const retryAfterMatch = RETRY_AFTER_RE.exec(message);
  if (retryAfterMatch) {
    const epochMs = parseInt(retryAfterMatch[1]!, 10) * 1000;
    return new Date(epochMs).toISOString();
  }

  const wallClockMatch = WALL_CLOCK_RESET_RE.exec(message);
  if (wallClockMatch) return parseWallClockToISO(wallClockMatch[1]!, wallClockMatch[2]!);

  return null;
}
