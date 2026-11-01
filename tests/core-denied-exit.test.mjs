// core: a completed turn with a recorded denial is attention (exit 10) even when the provider CLI exits non-zero for it
// (Claude exits 1 when a denial made its result is_error, milestone 3 review item 3); any other non-zero exit fails (1).
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, footerOf } from "./helpers.mjs";

test("denied + completed + non-zero exit → 10; completed + non-zero exit without a denial → 1; a denial with exit 0 → 10", () => {
  const w = makeWorld({ git: false });
  const denied = w.call(["ask", "--to", "null", "--", "q"], { env: { COUNCIL_FAKE_DENY: "secret.txt", COUNCIL_FAKE_EXIT_CODE: "1" } });
  assert.equal(denied.status, 10, denied.stdout + denied.stderr);
  assert.match(footerOf(denied.stdout), /^council null needs attention · /);
  const failed = w.call(["ask", "--to", "null", "--", "q"], { env: { COUNCIL_FAKE_EXIT_CODE: "1" } });
  assert.equal(failed.status, 1);
  assert.match(footerOf(failed.stdout), /error: null exited with code 1/);
  const plain = w.call(["ask", "--to", "null", "--", "q"], { env: { COUNCIL_FAKE_DENY: "secret.txt" } });
  assert.equal(plain.status, 10);
  const crash = w.call(["ask", "--to", "null", "--", "q"], { env: { COUNCIL_FAKE_SCENARIO: "exit-nonzero", COUNCIL_FAKE_DENY: "secret.txt" } });
  assert.equal(crash.status, 1, "a turn that never completed still fails");
});
