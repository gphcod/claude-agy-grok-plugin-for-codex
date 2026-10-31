// S2.3: thread claims under claims/<provider>/<threadId> (ported from grok_plugin_for_codex tests/claims.test.mjs).
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BusyError, claimHeld, claimPath, claimThread, inspectClaim, ownedThreads, releaseClaims, releaseThread } from "../plugins/council/scripts/lib/core/claims.mjs";

const A = { id: "aaaaaaaaaaaaaaaa", ownerToken: "a".repeat(32), provider: "grok" };
const B = { id: "bbbbbbbbbbbbbbbb", ownerToken: "b".repeat(32), provider: "grok" };
const C = { id: "cccccccccccccccc", ownerToken: "c".repeat(32), provider: "claude" };
function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-claims-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

if (process.argv[2] === "claim-worker") {
  process.send("ready");
  process.once("message", () => {
    try { claimThread(process.argv[3], "grok", process.argv[4], JSON.parse(process.argv[5])); process.send("admitted"); }
    catch (error) { process.send(error instanceof BusyError ? "busy" : error.message); }
    process.disconnect();
  });
} else {
  test("barrier: exactly one process admits the same thread; other threads are independent", async (t) => {
    const dir = home(t);
    async function race(threads) {
      const children = threads.map((id, i) => fork(fileURLToPath(import.meta.url), ["claim-worker", dir, id, JSON.stringify(i ? B : A)], { stdio: ["ignore", "ignore", "inherit", "ipc"] }));
      t.after(() => children.forEach((child) => child.kill()));
      const exits = children.map((child) => once(child, "exit"));
      await Promise.all(children.map((child) => once(child, "message")));
      const answers = children.map((child) => once(child, "message"));
      children.forEach((child) => child.send("go"));
      const results = (await Promise.all(answers)).map(([answer]) => answer).sort();
      await Promise.all(exits);
      return results;
    }
    assert.deepEqual(await race(["shared", "shared"]), ["admitted", "busy"]);
    assert.deepEqual(await race(["one", "two"]), ["admitted", "admitted"]);
  });

  test("claims are namespaced by provider: the same native id is free for another provider", (t) => {
    const dir = home(t);
    claimThread(dir, "grok", "thread-x", A);
    assert.equal(claimPath(dir, "grok", "Thread-X"), path.join(dir, "claims", "grok", "thread-x"));
    assert.throws(() => claimThread(dir, "grok", "thread-x", B), BusyError);
    claimThread(dir, "claude", "thread-x", C);
    assert.deepEqual([inspectClaim(dir, "grok", "thread-x").job, inspectClaim(dir, "claude", "thread-x").job], [A.id, C.id]);
    assert.deepEqual(ownedThreads(dir, A), ["thread-x"]);
    assert.deepEqual(ownedThreads(dir, C), ["thread-x"]);
    assert.deepEqual(ownedThreads(dir, { ...A, provider: "gemini" }), [], "another provider's namespace holds nothing for this job");
    releaseClaims(dir, A);
    assert.equal(inspectClaim(dir, "grok", "thread-x").state, "absent");
    assert.equal(inspectClaim(dir, "claude", "thread-x").state, "owned", "releasing one provider's claim leaves the other");
    assert.equal(claimHeld(dir, C), true);
    assert.equal(claimHeld(dir, A), false);
  });

  test("old delayed releaser cannot remove a newer owner", (t) => {
    const dir = home(t);
    claimThread(dir, "grok", "thread", A);
    let removed = false;
    const io = { ...fs, rmdirSync(p) {
      assert.equal(releaseThread(dir, "grok", "thread", A), false);
      assert.throws(() => claimThread(dir, "grok", "thread", B), BusyError);
      fs.rmdirSync(p);
      removed = true;
    } };
    assert.equal(releaseThread(dir, "grok", "thread", A, io), true);
    assert.ok(removed);
    claimThread(dir, "grok", "thread", B);
    assert.equal(releaseThread(dir, "grok", "thread", A), false);
    assert.equal(inspectClaim(dir, "grok", "thread").job, B.id);
  });

  test("empty, unreadable and failed-publication claims stay blocked, and a left claim is marked", (t) => {
    const dir = home(t);
    fs.mkdirSync(path.join(dir, "claims", "grok", "empty"), { recursive: true });
    assert.throws(() => claimThread(dir, "grok", "empty", A), BusyError);
    assert.equal(releaseThread(dir, "grok", "empty", A), false);
    assert.equal(inspectClaim(dir, "grok", "empty").state, "unknown");
    const io = { ...fs, writeFileSync() { throw new Error("disk full"); } };
    assert.throws(() => claimThread(dir, "grok", "failed", A, io), (e) => /disk full/.test(e.message) && e.claimLeft === true);
    assert.throws(() => claimThread(dir, "grok", "failed", B), (e) => e instanceof BusyError && e.job === null && /unidentified claim/.test(e.message));
    assert.equal(inspectClaim(dir, "grok", "failed").state, "unknown");
    assert.equal(claimHeld(dir, { ...B, threadIds: ["failed"] }), true, "an unknown claim on one of the job's threads counts as held");
    const denied = { ...fs, readdirSync() { throw Object.assign(new Error(), { code: "EACCES" }); } };
    assert.equal(inspectClaim(dir, "grok", "empty", denied).state, "unknown");
    claimThread(dir, "grok", "busy", A);
    assert.throws(() => claimThread(dir, "grok", "busy", B), (e) => e instanceof BusyError && e.job === A.id && /busy as job aaaaaaaaaaaaaaaa; wait or cancel/.test(e.message));
  });

  test("requested and returned ids stay owned; release is owner-specific and idempotent", (t) => {
    const dir = home(t);
    claimThread(dir, "grok", "requested", A);
    claimThread(dir, "grok", "returned", A);
    claimThread(dir, "grok", "requested", A);
    assert.deepEqual(ownedThreads(dir, A).sort(), ["requested", "returned"]);
    assert.throws(() => claimThread(dir, "grok", "returned", B), BusyError);
    releaseThread(dir, "grok", "returned", A);
    assert.equal(inspectClaim(dir, "grok", "requested").job, A.id);
    releaseThread(dir, "grok", "requested", A);
    assert.equal(releaseThread(dir, "grok", "requested", A), false);
    assert.deepEqual(ownedThreads(dir, { id: "x", provider: "grok" }), [], "no token, nothing owned");
  });

  test("thread, provider and owner inputs cannot escape the state root", (t) => {
    const dir = home(t);
    for (const id of ["../other", "a/b", "", ".", "..", "a b"]) assert.throws(() => claimThread(dir, "grok", id, A), /invalid native thread id/);
    for (const provider of ["../x", "", "Grok", "a/b"]) assert.throws(() => claimThread(dir, provider, "valid", A), /invalid provider id/);
    assert.throws(() => claimThread(dir, "grok", "valid", { ...A, ownerToken: "../bad" }), /token/);
    assert.deepEqual(ownedThreads(dir, { ...A, provider: "../x" }), []);
  });
}
