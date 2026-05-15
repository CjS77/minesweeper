import { describe, expect, it } from "vitest";
import { isApiLimitError, resumeTimeFromError } from "../errors.js";

function ok(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

function statusCode(code: number): Error & { statusCode: number } {
  return Object.assign(new Error(`HTTP ${code}`), { statusCode: code });
}

describe("isApiLimitError", () => {
  it.each([
    ["status 429", ok(429)],
    ["status 529", ok(529)],
    ["statusCode 429", statusCode(429)],
    ["statusCode 529", statusCode(529)],
    ["name RateLimitError", Object.assign(new Error("nope"), { name: "RateLimitError" })],
    ["name rate-limit-error", Object.assign(new Error("nope"), { name: "rate-limit-error" })],
    ["name overloaded", Object.assign(new Error("nope"), { name: "overloaded" })],
    ["message contains 429", new Error("received 429 from upstream")],
    ["message contains 529", new Error("got 529 overloaded")],
    ["message contains 'rate limit'", new Error("You hit your rate limit")],
    ["message contains 'rate_limit'", new Error("rate_limit exceeded")],
    ["message contains 'rate-limit'", new Error("rate-limit hit")],
    ["message contains 'overload'", new Error("The API is overloaded right now")],
    ["message contains 'overloaded'", new Error("You're overloaded!")],
    ["message contains 'usage limit'", new Error("Exceeded usage limit for today")],
    ["message contains 'hit your limit'", new Error("You hit your limit")],
    ["message contains 'resets 3'", new Error("Your quota resets 3 minutes from now")],
  ])("returns true for %s", (_label, err) => {
    expect(isApiLimitError(err)).toBe(true);
  });

  it.each([
    ["plain compile error", new Error("tsc failed: cannot find module")],
    ["null", null],
    ["undefined", undefined],
    ["a string", "rate limit exceeded"],
    ["status 500", ok(500)],
    ["status 404", ok(404)],
    ["empty object", {}],
  ])("returns false for %s", (_label, val) => {
    expect(isApiLimitError(val)).toBe(false);
  });
});

describe("resumeTimeFromError", () => {
  it("extracts an ISO timestamp embedded in the message", () => {
    const err = new Error("Retry after 2026-06-01T12:30:00.000Z when quota resets");
    expect(resumeTimeFromError(err)).toBe("2026-06-01T12:30:00.000Z");
  });

  it("extracts an epoch-seconds reset value after 'retry-after' keyword", () => {
    const epoch = 1800000000; // 2027-01-15T08:00:00.000Z
    const err = new Error(`rate limited; retry-after: ${epoch}`);
    const result = resumeTimeFromError(err);
    expect(result).toBe(new Date(epoch * 1000).toISOString());
  });

  it("extracts resume time from a localised wall-clock message", () => {
    const err = new Error("Your quota resets at 3:50pm (Europe/Lisbon)");
    const result = resumeTimeFromError(err);
    expect(result).not.toBeNull();
    // Verify the returned UTC instant maps back to 15:50 in Europe/Lisbon
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Lisbon",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    expect(formatter.format(new Date(result!))).toBe("15:50");
  });

  it("returns null for a non-object input", () => {
    expect(resumeTimeFromError(null)).toBeNull();
    expect(resumeTimeFromError(undefined)).toBeNull();
    expect(resumeTimeFromError("rate limit")).toBeNull();
    expect(resumeTimeFromError(42)).toBeNull();
  });

  it("returns null when there is no message property", () => {
    expect(resumeTimeFromError({})).toBeNull();
    expect(resumeTimeFromError({ code: 429 })).toBeNull();
  });
});
