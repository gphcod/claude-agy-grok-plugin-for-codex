// IPC barriers for the lifecycle integration tests (ported from grok_plugin_for_codex tests/lifecycle-worker.mjs): runs one
// managed turn of the null adapter in its own companion process, pausing at a named hook until the test says "go".
import fs from "node:fs";
import { runManagedTurn } from "../../plugins/council/scripts/lib/core/lifecycle.mjs";
import adapter from "./null-adapter.mjs";

const config = JSON.parse(process.argv[2]);
const barrier = (name) => async (job) => {
  process.send?.({ name, id: job.id });
  await new Promise((resolve) => process.once("message", resolve));
};
const hooks = { announce: (job) => console.log(`job=${job.id}`) };
if (config.barrier) hooks[config.barrier] = barrier(config.barrier);
if (config.failAppend) hooks.io = { ...fs, appendFileSync(file, ...rest) { if (String(file).endsWith("events.jsonl")) throw new Error("fixture disk full"); return fs.appendFileSync(file, ...rest); } };
if (config.failFinalize) hooks.markDone = () => { throw new Error("fixture marker failure"); };
for (const key of ["drainMs", "retryMs", "shutdownMs", "pipeWaitMs", "graceMs"]) if (config[key] !== undefined) hooks[key] = config[key];
const env = { ...process.env, ...config.env };
const turn = { verb: config.verb ?? "reply", cwd: config.cwd, tier: "consult", model: "null-model", effort: "low", requestedEffort: "low", modelVerified: true, thread: config.thread ?? null,
  confirmed: Boolean(config.thread), round: config.round ?? 1, rounds: 9, prompt: config.text ?? "more", launcher: adapter.resolveLauncher(env),
  build: (jobDir) => adapter.buildTurn({ verb: config.verb ?? "reply", prompt: config.text ?? "more", model: "null-model", effort: "low", env, resume: Boolean(config.thread), threadId: config.thread ?? null, jobDir }) };
try {
  const result = await runManagedTurn({ home: config.home, env, cwd: config.cwd, session: null }, adapter, turn, () => turn,
    { json: false, deadlineMs: config.deadlineMs ?? 30000, inactivityMs: config.inactivityMs ?? 30000 }, hooks);
  console.log(`outcome=${result.job.outcome} code=${result.job.code} error=${result.job.error ?? ""}`);
  process.exitCode = result.job.code;
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
}
process.disconnect?.();
