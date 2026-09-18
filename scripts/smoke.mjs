import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const dataHome = mkdtempSync(join(tmpdir(), "dev-smoke-"));
try {
  const output = execFileSync(process.execPath, ["bin/dev.mjs", "--diagnostics", "--data-home", dataHome], { encoding: "utf8" });
  if (!output.includes("pi: 0.85.1") || !output.includes("selection: general")) throw new Error(`Unexpected diagnostics:\n${output}`);
  console.log(output.trim());
} finally {
  rmSync(dataHome, { recursive: true, force: true });
}
