import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PACKAGE_VERSION } from "../version.js";

describe("PACKAGE_VERSION", () => {
  it("matches the version field in package.json", () => {
    const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });

  it("is a non-empty semver-shaped string", () => {
    expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
