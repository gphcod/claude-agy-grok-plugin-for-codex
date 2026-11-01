// Frozen contracts (S2.7): the adapter object of A5, the request the entry hands to `buildTurn`, the turn it returns, the
// events `parseEvent` yields and the normalized review result of A5.2, as JSDoc typedefs; and `assertAdapter`, which the
// entry runs on every provider module it loads. Changing any of these needs a docs/decisions.md entry and a review
// (S2.8 added `checkRequest`, the request's `launcher`, `env` on probe, ParsedEvent `model`, ProbeResult `warnings`).

/** @typedef {"native" | "node-script" | "shim-native" | "shim-node"} LauncherKind */
/** @typedef {{ command: string, args: string[], path: string, kind: LauncherKind }} Launcher */
/** @typedef {{ kind: "file" | "dir" | "exec" | "listener" | "process-table" | "network", target: any, access?: "read" | "write", timeoutMs?: number, why: string, action?: string }} PreflightDescriptor */
/** @typedef {{ version: string | null, loggedIn: boolean | null, models: { id: string, efforts: string[] }[] | null, warnings?: string[] }} ProbeResult `setup` prints each warning */
/**
 * @typedef {object} TurnRequest
 * @property {"ask" | "reply" | "review" | "task"} verb
 * @property {boolean} nextInput        a `reply --next-input` delivering a saved review batch
 * @property {string} text              the user's text (the review focus on a review)
 * @property {string} prompt            the text, or the rendered batch prompt on a review
 * @property {string | null} instructions the per-turn template (advice or task); null on reviews, whose prompt carries it
 * @property {string} contractPath      contract.md, the mode-neutral standing contract
 * @property {string | null} model      the resolved model id; null means the provider's configured default (no flag)
 * @property {string | undefined} effort
 * @property {boolean} resume           continue `threadId`
 * @property {string | null} threadId   the native thread id on a resume
 * @property {string} cwd
 * @property {Record<string, string>} env  the per-call environment; adapters never read process.env
 * @property {Launcher} launcher        the launcher the entry resolved for this call
 * @property {string | null} schemaPath the review schema on structured turns
 * @property {boolean} structured
 * @property {boolean} readOnly         false only on `task`
 * @property {boolean} web
 * @property {string[]} allowCommands   `--allow-command` values (Gemini tasks)
 * @property {number | null} maxTurns
 * @property {number | null} maxBudgetUsd
 * @property {{ version: string, readRoots: string[], web: boolean, allowMcp: boolean }} policy
 * @property {string | null} agent      the agent the thread last ran (Grok)
 * @property {string} jobDir
 */
/**
 * @typedef {object} BuiltTurn
 * @property {string[]} args
 * @property {Record<string, string>} [env]
 * @property {string} [stdin]           written to the child's stdin; omit to ignore stdin
 * @property {string | null} [promptFile] written by the lifecycle before spawn
 * @property {string} [promptText]     the prompt file's content when the adapter composes it (default: `stdin`, else the request prompt)
 * @property {string | null} [answerFile] where the child writes its answer, when it does
 * @property {boolean} readOnly
 * @property {string | null} [requestedThreadId] a thread id chosen before spawn (claimed before the child starts)
 * @property {string | null} [agent]
 * @property {string} contractCarrier
 */
/**
 * @typedef {object} ParsedEvent
 * @property {string} [threadId] @property {string} [textDelta] @property {string} [toolStep] @property {boolean} [completed]
 * @property {string} [fatal] @property {object} [denied] @property {string} [incomplete] @property {object} [structured]
 * @property {string | string[]} [edited] @property {string} [failedCommand] @property {number} [costUsd] @property {object} [usage]
 * @property {string} [model] the model the provider reports using (Claude's system/init); stored as the job's model when `default` was requested
 */
/**
 * @typedef {object} NormalizedReview
 * @property {"approve" | "changes" | "incomplete"} verdict
 * @property {{ id: string, severity: "BLOCKER" | "MAJOR" | "MINOR", file: string, line: number, title: string, text: string, recommendation?: string, decision?: "AGREE" | "CHANGE" | "REJECT" }[]} findings
 * @property {{ reviewed: number, unreviewed: number, pending: number }} coverage
 * @property {string | null} incomplete
 * @property {0 | 10} exit
 */
/**
 * @typedef {object} Adapter
 * @property {string} id
 * @property {string} binEnv
 * @property {(env: Record<string, string>, platform?: string) => Launcher | null} resolveLauncher
 * @property {(launcher: Launcher) => boolean} trustsCleanExit
 * @property {(row: object, job: object, platform: string, hasFlagOperand: Function) => boolean} ownsProcess
 * @property {number} maxLineBytes
 * @property {(launcher: Launcher, env: Record<string, string>) => Promise<ProbeResult>} probe
 * @property {(ctx: { stateRoot: string, env: object, platform: string, verb: string, cwd: string }) => PreflightDescriptor[]} preflight
 * @property {object} catalog
 * @property {(request: TurnRequest) => BuiltTurn} buildTurn
 * @property {(request: TurnRequest, env: Record<string, string>) => string | null} [checkRequest] a refusal message (exit 2, before
 *   any job record and before the request id is tombstoned) or null
 * @property {(ctx: { job: object, request: TurnRequest, cwd: string, env: object }) => any} [beforeTurn]
 * @property {(ctx: { job: object, request: TurnRequest | null, cwd: string, env: object }, outcome: { cleanupConfirmed: true, reason: string | null, completed: boolean, denials: object[], deferred?: true }) => any} [afterTurn]
 *   once, only after verified cleanup: a turn that ends with cleanup pending defers it to the `cancel` that confirms
 *   cleanup (request null, `deferred: true`, its result ignored). A deferred run whose cancel died mid-hook is run again
 *   by the next cancel (S2.10), so afterTurn must tolerate a re-run (idempotent, or harmless when repeated)
 * @property {(line: string, state: object) => ParsedEvent | null} parseEvent `state.adapter` is the per-turn scratch, seeded with the
 *   BuiltTurn's `{ readOnly, agent }` before the first event
 * @property {(review: object, request: { adversarial: boolean }) => { native: false, batches?: any, promptTemplate: string, schemaCarrier: "inline" | "path" | "flag" | "embed" }} reviewPlan
 * @property {(input: { answerText: string | null, structured: object | null, unreviewed: string[], batch: object | null, ledger: object[] }) => object | null} finalizeReview
 *   `answerText` is the complete spooled answer (uncapped); called only after every success condition holds
 */

/** The A5 members every provider module must export, with their types; checkRequest and the two lifecycle hooks are optional. */
export const ADAPTER_MEMBERS = Object.freeze({ id: "string", binEnv: "string", resolveLauncher: "function", trustsCleanExit: "function", ownsProcess: "function",
  maxLineBytes: "number", probe: "function", preflight: "function", catalog: "object", buildTurn: "function", parseEvent: "function", reviewPlan: "function", finalizeReview: "function" });
export const OPTIONAL_MEMBERS = Object.freeze({ checkRequest: "function", beforeTurn: "function", afterTurn: "function" });
/** Exit codes (A3.4). */
export const EXIT = Object.freeze({ ok: 0, attention: 10, running: 20, failed: 1, usage: 2 });

/** Throws when a loaded provider module does not implement the frozen interface; returns it otherwise. */
export function assertAdapter(adapter, expectedId) {
  if (!adapter || typeof adapter !== "object") throw new Error(`provider ${expectedId} exports no adapter object`);
  const problems = Object.entries(ADAPTER_MEMBERS).filter(([key, type]) => typeof adapter[key] !== type || (type === "object" && adapter[key] === null)).map(([key, type]) => `${key} (${type})`);
  problems.push(...Object.entries(OPTIONAL_MEMBERS).filter(([key, type]) => adapter[key] !== undefined && typeof adapter[key] !== type).map(([key, type]) => `${key} (${type} or absent)`));
  if (adapter.id !== expectedId) problems.push(`id "${expectedId}"`);
  if (problems.length) throw new Error(`provider ${expectedId} does not implement the adapter interface: missing or wrong ${problems.join(", ")}`);
  return adapter;
}
