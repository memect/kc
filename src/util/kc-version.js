// Single source of truth for the live KC CLI version string.
//
// Reads package.json once. Used by engine.js (passed to ReleaseTool so
// release manifests stamp the correct version) and by
// pipelines/finalization.js (anywhere it surfaces "Built by kc-beta X").
//
// Before v0.7.2, engine.js hardcoded `kcVersion: "0.5.2"` which leaked
// into every release manifest's `kc_beta_version` field regardless of
// the actual package version. Both v0.7.1 audit runs (DS + GLM)
// surfaced this. Reading package.json closes the gap.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function readKcVersion() {
  try {
    const pkgPath = path.resolve(__dirname, "../../package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}
