// Runs the companion entry in its own process with lifecycle hooks the command line cannot pass (a failing done marker),
// so the companion is gone afterwards, as a crashed or failed companion would be. Config: {argv, cwd, failFinalize}.
import { main } from "../../plugins/council/scripts/council.mjs";

const config = JSON.parse(process.argv[2]);
const hooks = {};
if (config.failFinalize) hooks.markDone = () => { throw new Error("fixture marker failure"); };
process.exitCode = await main(config.argv, process.env, { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin }, { cwd: config.cwd, hooks });
