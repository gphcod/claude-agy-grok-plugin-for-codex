// S1.4 item 3: the resources Codex's `workspace-write` sandbox blocked in the host probe (docs/spike/codex-host.md),
// simulated against the three fakes: council's state root and Claude's and agy's directories not writable, the process
// table unavailable (no `ps`), the loopback listener refused, the network unreachable; Grok's login file readable. Every
// provider's turn must exit 1 `preflight_blocked` with an action line naming the first blocked resource, which is
// council's own state root, and start nothing; with the state root writable, each provider names its next blocked one.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, ROOT, BINARY } from "./helpers.mjs";
import { PROVIDERS } from "../plugins/council/scripts/lib/core/host.mjs";
import { stateRootDescriptor } from "../plugins/council/scripts/lib/core/preflight.mjs";
import claude from "../plugins/council/scripts/lib/providers/claude.mjs";
import gemini from "../plugins/council/scripts/lib/providers/gemini.mjs";
import grok from "../plugins/council/scripts/lib/providers/grok.mjs";

const FAKES = { claude: "fake-claude.mjs", gemini: "fake-agy.mjs", grok: "fake-grok.mjs" };
const posixUser = process.platform !== "win32" && process.getuid?.() !== 0;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function sandboxed(t) {
  const w = makeWorld();
  delete w.env.COUNCIL_TEST_NULL_ADAPTER;
  for (const provider of PROVIDERS) w.env[BINARY[provider][1]] = path.join(ROOT, "tests", "fixtures", FAKES[provider]);
  fs.mkdirSync(path.join(w.dir, ".grok"));
  fs.writeFileSync(path.join(w.dir, ".grok", "auth.json"), "{}", { mode: 0o600 });
  const readOnly = [w.home, path.join(w.dir, ".claude", "projects"), path.join(w.dir, ".gemini", "antigravity-cli")];
  for (const dir of readOnly) { fs.mkdirSync(dir, { recursive: true }); fs.chmodSync(dir, 0o555); }
  t.after(() => { for (const dir of readOnly) fs.chmodSync(dir, 0o755); });
  const noTools = path.join(w.dir, "empty-path");
  fs.mkdirSync(noTools);
  // No `ps` (the probe saw exit 127), an unassignable listener address (EPERM there), an unreachable API endpoint.
  Object.assign(w.env, { PATH: noTools, COUNCIL_AGY_LISTEN_HOST: "192.0.2.1", ANTHROPIC_BASE_URL: "http://127.0.0.1:9", CODEX_SANDBOX: "seatbelt", CODEX_SANDBOX_NETWORK_DISABLED: "1" });
  for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"]) delete w.env[name];
  w.logged = () => (fs.existsSync(w.env.COUNCIL_FAKE_LOG) ? fs.readFileSync(w.env.COUNCIL_FAKE_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  w.writable = (dir) => fs.chmodSync(dir, 0o755);
  return w;
}

test("workspace-write as measured: every provider's turn is preflight_blocked on council's state root, request id or not, with zero probes and submissions", { skip: !posixUser && "needs POSIX permissions and a non-root user" }, (t) => {
  const w = sandboxed(t);
  for (const provider of PROVIDERS) {
    for (const args of [["ask", "--to", provider, "--", "q"], ["ask", "--to", provider, "--request-id", `r-${provider}`, "--", "q"], ["task", "--to", provider, "--request-id", `t-${provider}`, "--", "edit"]]) {
      const r = w.call(args);
      assert.equal(r.status, 1, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, new RegExp(`^council: preflight_blocked: council job records \\(dir ${escape(w.home)}\\): write access is missing \\(EACCES\\)\\naction: Grant write access to the council state root ${escape(w.home)} \\(under Codex workspace-write, add it as a writable root or run with danger-full-access\\)`), args.join(" "));
    }
  }
  assert.deepEqual(w.logged(), [], "no probe and no submission reached any CLI");
  assert.deepEqual(fs.readdirSync(w.home), [], "nothing was written under the state root");
});

test("with the state root writable, each provider names its own next blocked resource first; still zero submissions", { skip: !posixUser && "needs POSIX permissions and a non-root user" }, (t) => {
  const w = sandboxed(t);
  w.writable(w.home);
  const expected = {
    claude: ["process identity and cleanup \\(process-table ps\\)", /action: Allow the process-table query/],
    gemini: [`agy backend state \\(~/\\.gemini/antigravity-cli\\) \\(dir ${escape(path.join(w.dir, ".gemini", "antigravity-cli"))}\\): write access is missing`, /action: Grant write access to .*antigravity-cli\. Run Codex with a sandbox that allows it/],
    grok: ["process-table query for cleanup and ownership \\(process-table ps\\)", /action: Allow process inspection/],
  };
  for (const provider of PROVIDERS) {
    const r = w.call(["ask", "--to", provider, "--request-id", `n-${provider}`, "--", "q"]);
    assert.equal(r.status, 1, `${provider}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, new RegExp(`^council: preflight_blocked: ${expected[provider][0]}`), provider);
    assert.match(r.stderr, expected[provider][1], provider);
  }
  assert.deepEqual(w.logged(), [], "sandbox checks run before any probe");
  // Claude now checks process identity before storage. Restore only PATH to exercise the next blocker.
  w.env.PATH = process.env.PATH;
  const storage = w.call(["ask", "--to", "claude", "--", "q"]);
  assert.equal(storage.status, 1, storage.stdout + storage.stderr);
  assert.match(storage.stderr, /^council: preflight_blocked: Claude session storage .*write access is missing/);
  assert.match(storage.stderr, /action: Grant write access to .*\.claude\/projects/);
  assert.deepEqual(w.logged(), [], "storage check still precedes provider probes");
  // Claude with its storage writable and the network still unreachable: the cold probes run, the network check blocks.
  w.writable(path.join(w.dir, ".claude", "projects"));
  const net = w.call(["ask", "--to", "claude", "--", "q"]);
  assert.equal(net.status, 1, net.stdout + net.stderr);
  assert.match(net.stderr, /^council: preflight_blocked: Anthropic API \(network http:\/\/127\.0\.0\.1:9\): network access failed/);
  assert.match(net.stderr, /\naction: Restore network\/proxy\/certificate access to http:\/\/127\.0\.0\.1:9/);
  assert.ok(w.logged().every((e) => e.probe), "only the non-billable probes ran; no submission");
});

test("every provider lists council's state root as its first preflight descriptor, with the one state-root action line", () => {
  for (const adapter of [claude, gemini, grok]) {
    for (const env of [{ HOME: "/home/u", [adapter.binEnv]: path.join(ROOT, "tests", "fixtures", FAKES[adapter.id]) }, { HOME: "/home/u", GROK_API_KEY: "k", PATH: "" }]) {
      const list = adapter.preflight({ stateRoot: "/state", env, platform: "darwin", verb: "ask", cwd: "/w" });
      assert.deepEqual(list[0], stateRootDescriptor("/state"), adapter.id);
      assert.equal(list.filter((d) => d.target === "/state").length, 1, `${adapter.id}: listed once`);
    }
  }
});
