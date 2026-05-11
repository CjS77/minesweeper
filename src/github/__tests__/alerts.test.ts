import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AlertStateSchema,
  CodeScanningAlertListSchema,
  CodeScanningAlertSchema,
  SecretScanningAlertListSchema,
  SecretScanningAlertSchema,
} from "../models.js";

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__");
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIX_DIR, name), "utf8")) as unknown;

describe("AlertStateSchema", () => {
  it.each(["open", "dismissed", "fixed", "auto_dismissed", "resolved"] as const)("accepts %s", (s) => {
    expect(AlertStateSchema.parse(s)).toBe(s);
  });

  it("rejects an unknown state", () => {
    expect(() => AlertStateSchema.parse("revoked")).toThrow();
  });
});

describe("CodeScanningAlertSchema", () => {
  it("parses a list fixture", () => {
    const alerts = CodeScanningAlertListSchema.parse(fixture("code_scanning_alert_list.json"));
    expect(alerts).toHaveLength(2);
    expect(alerts[0]?.number).toBe(4);
    expect(alerts[0]?.state).toBe("open");
    expect(alerts[0]?.rule.id).toBe("js/zipslip");
    expect(alerts[0]?.most_recent_instance?.location?.path).toBe("spec-main/api-session-spec.ts");
    expect(alerts[1]?.state).toBe("fixed");
  });

  it("preserves unknown future fields via passthrough", () => {
    const alerts = CodeScanningAlertListSchema.parse(fixture("code_scanning_alert_list.json"));
    const instance = alerts[0]?.most_recent_instance as Record<string, unknown> | undefined;
    expect(instance?.extraFutureField).toBe("tolerated by passthrough");
  });

  it("rejects an alert with a non-positive number", () => {
    const list = fixture("code_scanning_alert_list.json") as Array<Record<string, unknown>>;
    const bad = { ...list[0], number: 0 };
    expect(() => CodeScanningAlertSchema.parse(bad)).toThrow();
  });

  it("rejects an alert with a malformed url", () => {
    const list = fixture("code_scanning_alert_list.json") as Array<Record<string, unknown>>;
    const bad = { ...list[0], html_url: "not a url" };
    expect(() => CodeScanningAlertSchema.parse(bad)).toThrow();
  });
});

describe("SecretScanningAlertSchema", () => {
  it("parses a list fixture", () => {
    const alerts = SecretScanningAlertListSchema.parse(fixture("secret_scanning_alert_list.json"));
    expect(alerts).toHaveLength(2);
    expect(alerts[0]?.number).toBe(2);
    expect(alerts[0]?.secret_type_display_name).toBe("Adafruit IO Key");
    expect(alerts[0]?.state).toBe("open");
    expect(alerts[1]?.state).toBe("resolved");
    expect(alerts[1]?.resolution).toBe("false_positive");
  });

  it("preserves unknown future fields via passthrough", () => {
    const alerts = SecretScanningAlertListSchema.parse(fixture("secret_scanning_alert_list.json"));
    const first = alerts[0] as Record<string, unknown>;
    expect(first.extraFutureField).toBe("tolerated by passthrough");
  });

  it("rejects an alert missing required fields", () => {
    expect(() => SecretScanningAlertSchema.parse({ number: 1, state: "open" })).toThrow();
  });
});
