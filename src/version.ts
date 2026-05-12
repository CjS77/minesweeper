/**
 * Single source of truth for the running Minesweeper version.
 *
 * Reads the `"version"` field from `package.json` at module load using
 * `createRequire` so the same code works whether we're executing
 * `dist/cli.js` (installed/prod) or `src/cli.ts` via tsx (dev): both layouts
 * sit one directory below the repo root, so `../package.json` resolves
 * relative to `import.meta.url` in both cases.
 *
 * `package.json` lives outside `tsconfig.json`'s `rootDir`, so we cannot use
 * a static JSON import; `createRequire` is the idiomatic Node ESM escape
 * hatch for this.
 */
import { createRequire } from "node:module";

const requireFromHere = createRequire(import.meta.url);
const pkg = requireFromHere("../package.json") as { version: string };

export const PACKAGE_VERSION: string = pkg.version;
