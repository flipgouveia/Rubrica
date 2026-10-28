#!/usr/bin/env node
// Fails if `src/ipc/bindings.ts` doesn't match what the Rust source of truth
// (`src-tauri/src/types.rs` + `commands/**`) actually generates — CONTRACTS §1:
// bindings.ts is generated, never hand-edited, and CI must catch drift.
//
// Regenerates bindings.ts in place (via `cargo test --test export_bindings`,
// the same command `pnpm bindings:generate` runs) and diffs it against what
// git already has committed. Run locally after any change to `types.rs` or a
// command signature, before committing.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1");
const bindingsPath = "src/ipc/bindings.ts";

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  });
}

if (!existsSync(`${repoRoot}/${bindingsPath}`)) {
  console.error(`${bindingsPath} does not exist — run \`pnpm bindings:generate\` first.`);
  process.exit(1);
}

console.log("Regenerating bindings.ts from the Rust source of truth...");
try {
  run("cargo", [
    "test",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--test",
    "export_bindings",
  ]);
} catch (err) {
  console.error("Failed to run the Rust export_bindings test:");
  console.error(err.message);
  process.exit(1);
}

let diff;
try {
  diff = run("git", ["diff", "--stat", "--exit-code", "--", bindingsPath]);
} catch (err) {
  console.error(`\n${bindingsPath} is out of date with the Rust source of truth.`);
  console.error("The regenerated file differs from what's committed:\n");
  try {
    console.error(run("git", ["diff", "--", bindingsPath]));
  } catch {
    // best-effort extra context; the --stat output above already failed the check
  }
  console.error(
    "\nRun `pnpm bindings:generate` and commit the result — never hand-edit bindings.ts.",
  );
  process.exit(1);
}

console.log(`${bindingsPath} matches the Rust source of truth. No drift.`);
if (diff.trim()) {
  console.log(diff);
}
