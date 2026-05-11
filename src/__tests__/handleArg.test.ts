import { describe, expect, it } from "vitest";
import { parseHandleArg } from "../handleArg.js";

describe("parseHandleArg", () => {
  it("parses a bare numeric arg as an issue (back-compat)", () => {
    expect(parseHandleArg("42")).toEqual({ kind: "issue", number: 42 });
    expect(parseHandleArg("1")).toEqual({ kind: "issue", number: 1 });
  });

  it("parses the explicit `issue/<N>` form", () => {
    expect(parseHandleArg("issue/7")).toEqual({ kind: "issue", number: 7 });
  });

  it("parses code-scanning alert refs", () => {
    expect(parseHandleArg("codeScanningAlert/42")).toEqual({ kind: "codeScanningAlert", number: 42 });
  });

  it("parses secret-scanning alert refs", () => {
    expect(parseHandleArg("secretScanningAlert/13")).toEqual({ kind: "secretScanningAlert", number: 13 });
  });

  it.each(["", "abc", "0", "-3", "1.5", "issue/", "issue/foo", "alert/42", "csa/1", "/42", "42/"])(
    "rejects malformed input %s",
    (raw) => {
      expect(() => parseHandleArg(raw)).toThrow();
    },
  );
});
