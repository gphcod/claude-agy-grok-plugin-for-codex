// Opt-in benchmark instrumentation, never loaded by the shipped plugin. Log categories, never prompt/argv contents.
const fs = require("node:fs");
const cp = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const file = process.env.COUNCIL_BENCH_TRACE;
if (file) {
  const kind = (exe, args = []) => /(?:^|[\\/])(?:powershell(?:\.exe)?|pwsh(?:\.exe)?|ps)$/i.test(exe) ? "process-query" : args.some((arg) => /fake-(?:claude|agy|grok)\.mjs$/.test(arg)) ? "fake-cli" : "other";
  const log = (row) => fs.appendFileSync(file, `${JSON.stringify(row)}\n`, "utf8");
  const storage = { kind: "storage", inventoryReads: 0, metadataReads: 0, renames: 0, preflightCacheWrites: 0 };
  const normalized = (name) => typeof name === "string" ? name.replaceAll("\\", "/") : "";
  const originalRead = fs.readFileSync, originalList = fs.readdirSync, originalRename = fs.renameSync;
  fs.readFileSync = function (name, ...args) { if (normalized(name).endsWith("/meta.json")) storage.metadataReads++; return originalRead.call(this, name, ...args); };
  fs.readdirSync = function (name, ...args) { if (normalized(name).endsWith("/jobs")) storage.inventoryReads++; return originalList.call(this, name, ...args); };
  fs.renameSync = function (from, to) { const result = originalRename.call(this, from, to); storage.renames++; if (normalized(to).includes("/preflight/")) storage.preflightCacheWrites++; return result; };
  process.once("exit", () => log(storage));
  const originalFsync = fs.fsyncSync;
  fs.fsyncSync = function (fd) {
    const start = performance.now();
    const result = originalFsync.call(this, fd);
    log({ kind: "fsync", elapsedMs: performance.now() - start });
    return result;
  };
  const originalSync = cp.spawnSync;
  cp.spawnSync = function (exe, args, options) {
    const start = performance.now();
    const result = originalSync.call(this, exe, args, options);
    log({ kind: kind(exe, args), sync: true, elapsedMs: performance.now() - start, code: result.status });
    return result;
  };
  const originalSpawn = cp.spawn;
  cp.spawn = function (exe, args, options) {
    const start = performance.now();
    const child = originalSpawn.call(this, exe, args, options);
    child.once("close", (code) => log({ kind: kind(exe, args), sync: false, elapsedMs: performance.now() - start, code }));
    return child;
  };
  syncBuiltinESMExports();
}
