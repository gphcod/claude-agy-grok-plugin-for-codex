#!/usr/bin/env node
// One bounded provider fixture shared by old and new companions in host-collection benchmarks.
// It emits the same recorded successful stream after the same delay, without launching another CLI.
import fs from "node:fs";
import { createInterface } from "node:readline";
import { flagValue, sleep, spikeText, streams, UUID } from "./fake-common.mjs";

const argv = process.argv.slice(2);
const log = (entry) => {
  if (process.env.HOST_COLLECTION_LOG) fs.appendFileSync(process.env.HOST_COLLECTION_LOG, `${JSON.stringify(entry)}\n`, "utf8");
};
if (argv.includes("--version")) { log({ kind: "probe", probe: "version" }); console.log("2.1.314 (Claude Code)"); process.exit(0); }
if (argv[0] === "auth" && argv[1] === "status") {
  log({ kind: "probe", probe: "auth" });
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }));
  process.exit(0);
}
if (argv.includes("--help")) { log({ kind: "probe", probe: "help" }); process.stdout.write(spikeText("claude-help.txt")); process.exit(0); }
const contract = flagValue(argv, "--append-system-prompt-file");
if (contract && !fs.existsSync(contract)) {
  log({ kind: "probe", probe: "capability" });
  process.stderr.write(`Append system prompt file not found: ${contract}\n`);
  process.exit(1);
}
const session = flagValue(argv, "--session-id") ?? flagValue(argv, "--resume");
if (!UUID.test(session ?? "") || !argv.includes("--input-format")) throw new Error("expected one streaming Claude turn with its assigned session");
// Older companions leave stdin open for control messages; both protocols begin with one user line.
const reader = createInterface({ input: process.stdin });
const input = await new Promise((resolve, reject) => { reader.once("line", resolve); reader.once("error", reject); });
reader.close();
if (JSON.parse(input).type !== "user") throw new Error("expected the native user message");
const delayMs = Number(process.env.HOST_COLLECTION_DELAY_MS ?? 120000);
if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 180000) throw new Error("delay must be bounded to 0..180000ms");
log({ kind: "turn", session, delayMs, startedAt: Date.now() });
await sleep(delayMs);
for (const event of streams("claude").ok) process.stdout.write(`${JSON.stringify(event).replaceAll("<SESSION>", session)}\n`);
log({ kind: "end", session, emittedAt: Date.now() });
await new Promise((resolve) => process.stdout.write("", resolve));
process.exit(0);
