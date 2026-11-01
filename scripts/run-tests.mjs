#!/usr/bin/env node
// Runs the test files with Node's built-in runner. Discovery happens here, not in the shell: npm runs
// scripts through cmd.exe on Windows, which expands no globs, and Node 18's --test takes none either.
//   default : every tests/<dir>/*.test.mjs, excluding tests/live/ and every *.live.test.mjs
//   --live  : only tests/live/<dir>/*.live.test.mjs
//   --ratio : non-blank lines of tests/core-*.test.mjs divided by plugins/council/scripts/lib/core/*.mjs;
//             prints the ratio and exits 1 below 1.5
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RATIO_FLOOR = 1.5;

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}
const relative = (file) => path.relative(ROOT, file).split(path.sep).join("/");
export const isLiveFile = (rel) => rel.startsWith("tests/live/") || rel.endsWith(".live.test.mjs");

// The default set: every tests/<dir>/*.test.mjs that is not a live test.
export function defaultTests(root = ROOT) {
  return walk(path.join(root, "tests")).map((f) => path.relative(root, f).split(path.sep).join("/"))
    .filter((rel) => rel.endsWith(".test.mjs") && !isLiveFile(rel)).sort();
}
// The live set: only tests/live/<dir>/*.live.test.mjs.
export function liveTests(root = ROOT) {
  return walk(path.join(root, "tests", "live")).map((f) => path.relative(root, f).split(path.sep).join("/"))
    .filter((rel) => rel.endsWith(".live.test.mjs")).sort();
}
const nonBlank = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim()).length;
/** Core test lines over core module lines. */
export function coreRatio(root = ROOT) {
  const tests = walk(path.join(root, "tests")).filter((f) => /^core-.*\.test\.mjs$/.test(path.basename(f)));
  const core = walk(path.join(root, "plugins", "council", "scripts", "lib", "core")).filter((f) => f.endsWith(".mjs"));
  const testLines = tests.reduce((n, f) => n + nonBlank(f), 0);
  const coreLines = core.reduce((n, f) => n + nonBlank(f), 0);
  return { testLines, coreLines, ratio: coreLines ? testLines / coreLines : Infinity };
}

function main(argv) {
  // An unknown argument (for example `--help`) must never fall through to running a test set,
  // least of all the paid live set.
  const unknown = argv.filter((a) => a !== "--live" && a !== "--ratio");
  if (unknown.length) {
    console.error(`run-tests: unknown argument ${unknown.join(" ")}; usage: run-tests.mjs [--live | --ratio]`);
    return 2;
  }
  if (argv.includes("--ratio")) {
    const { testLines, coreLines, ratio } = coreRatio();
    console.log(`core test ratio: ${testLines} test lines / ${coreLines} core lines = ${ratio === Infinity ? "n/a" : ratio.toFixed(2)}`);
    return ratio >= RATIO_FLOOR ? 0 : 1;
  }
  const live = argv.includes("--live");
  const files = (live ? liveTests() : defaultTests()).map((rel) => path.join(ROOT, rel));
  if (!files.length) {
    console.error(`No ${live ? "live " : ""}test files found under tests/.`);
    return 1;
  }
  const extra = argv.filter((a) => a !== "--live");
  const result = spawnSync(process.execPath, ["--test", ...files, ...extra], { cwd: ROOT, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
