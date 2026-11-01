// Milestone 4 review item 1: macOS `ps -o lstart=` prints local time, and the stamps are identity evidence compared
// across processes (the owner records its identity; a later `cancel` compares). The darwin query must run with TZ=UTC
// and the stamps must be read as UTC, or a cancel run under another TZ reads a live owner as gone. Twin: a43d227.
import test from "node:test";
import assert from "node:assert/strict";
import { processSnapshot, sameIdentity, startTime, companionState } from "../plugins/council/scripts/lib/core/execution.mjs";

const BORN = Date.UTC(2026, 10, 1, 14, 39, 6);
/** A fake `ps` that prints one process born at BORN, its lstart rendered in the time zone the query runs under. */
function fakePs(seen) {
  return (command, args, options) => {
    const tz = options?.env?.TZ;
    seen.push(tz ?? null);
    const part = (o) => new Intl.DateTimeFormat("en-US", { ...o, timeZone: tz || undefined }).format(BORN);
    const day = String(Number(part({ day: "numeric" }))).padStart(2, " ");
    const time = part({ hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    const lstart = `${part({ weekday: "short" })} ${part({ month: "short" })} ${day} ${time} ${part({ year: "numeric" })}`;
    return { status: 0, stdout: `  4242     1  4242 ${process.getuid()} S    ${lstart} /usr/local/bin/node council.mjs ask\n` };
  };
}
function withTz(tz, fn) {
  const previous = process.env.TZ;
  try { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; return fn(); }
  finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
}

test("the darwin process query runs with TZ=UTC whatever the caller's TZ, so one process keeps one identity", () => {
  const seen = [];
  const rows = ["UTC", "America/Los_Angeles", "Asia/Tokyo", "Australia/Lord_Howe", undefined].map((tz) => withTz(tz, () => {
    const snap = processSnapshot({ platform: "darwin", run: fakePs(seen) });
    assert.equal(snap.state, "ok", String(tz));
    return snap.rows[0];
  }));
  assert.deepEqual(seen, ["UTC", "UTC", "UTC", "UTC", "UTC"]);
  for (const row of rows) assert.ok(sameIdentity(rows[0], row), `${row.stamp} vs ${rows[0].stamp}`);
  for (const row of rows) assert.equal(startTime(row.stamp), BigInt(BORN / 1000), "the stamp reads as the true birth time");
});

test("an owner recorded under one TZ is still live to a cancel run under another", () => {
  const record = withTz("UTC", () => processSnapshot({ platform: "darwin", run: fakePs([]) }).rows[0]);
  const snapshot = withTz("America/Los_Angeles", () => processSnapshot({ platform: "darwin", run: fakePs([]) }));
  assert.equal(companionState({ companionPid: 4242, companionIdentity: record }, snapshot), "live");
});

test("an lstart stamp is read as UTC, independent of the process TZ", () => {
  for (const tz of ["UTC", "America/Los_Angeles", "Asia/Kolkata"]) withTz(tz, () => {
    assert.equal(startTime("Sun Nov  1 14:39:06 2026".replace(/\s+/g, " ")), BigInt(BORN / 1000), tz);
  });
});
