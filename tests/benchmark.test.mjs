import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { quantile, summarize } from "../scripts/benchmark.mjs";

test("benchmark uses nearest-rank quantiles without mutating samples", () => {
  const values = Array.from({ length: 20 }, (_, index) => 20 - index);
  assert.equal(quantile(values, 0.5), 10);
  assert.equal(quantile(values, 0.95), 19);
  assert.equal(values[0], 20);
  assert.equal(quantile([], 0.95), null);
});
test("benchmark statistics never pool different arms, providers or workloads", () => {
  const row = (arm, provider, workload, elapsedMs) => ({ arm, provider, workload, elapsedMs, framingBytes: elapsedMs, providerInputBytes: 80, firstHandleMs: 20, fsyncs: 5, processQueries: 1, processQueryMs: 10, childStarts: 2, inventoryReads: 3, metadataReads: 100, preflightCacheWrites: 1 });
  const result = summarize([row("baseline", "claude", "ask", 100), row("candidate", "claude", "ask", 50), row("candidate", "gemini", "ask", 500), row("candidate", "claude", "reply", 200)]);
  assert.equal(result.length, 4);
  assert.equal(result.find((item) => item.arm === "candidate" && item.provider === "claude" && item.workload === "ask").medianMs, 50);
  assert.ok(result.every((item) => item.samples === 1 && item.medianProcessQueries === 1));
  assert.ok(result.every((item) => item.medianProviderInputBytes === 80 && item.medianFirstHandleMs === 20 && item.medianFsyncs === 5));
  assert.ok(result.every((item) => item.medianInventoryReads === 3 && item.medianMetadataReads === 100 && item.medianPreflightCacheWrites === 1));
});
test("benchmark rejects unknown flags before loading or invoking any provider", () => {
  const result = spawnSync(process.execPath, ["scripts/benchmark.mjs", "--live", "true"], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage: benchmark/);
});
