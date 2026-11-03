# 1.1.1 Windows release qualification

Owner date: 2026-11-02 Pacific (raw records use UTC). Runtime/test source: `66bea4982f5b016e173bf7dace6ef8a32e456d4d`; later qualification-only commits do not change the plugin payload.

`npm run validate` passes: **567 tests, 531 pass, 36 platform skips, zero failures**, 273,007 ms. Manifest, skill (2,987 B / 128 B description) and README checks pass. The existing 31 shell call-form checks passed after the 503 patch's CLI integration; subsequent changes only refine failure output, eligibility wording and partial-draft retention. No hosted CI was used.

Ten new service tests cover the exact native 503 signature, permanent negatives, denial precedence, partial/tool-active exclusions, ask/reply/review replay, fresh-id recovery, approval-shaped partial reviews, malformed-stream precedence and draft-save errors. Output regressions retain uncertainty warnings and manual batch continuation without suggesting automatic resubmission.

All six final real-host/fake-provider checks pass; [service qualification](gemini-service-recovery.md) and [structured evidence](../measurements/gemini-service-recovery-windows.json) include submission counts and limits. Both host actors stop after the permitted retry on persistent outage and do not repeat a partial turn. Native provider reviews and workflows are separate from these injected-failure tests.

The 1.1.0 matched runtime and host-collection studies remain historical evidence for the normal path; this patch does not rebrand them as a new cross-plugin or billing benchmark. Exact-payload macOS, interactive desktop discovery/wake and Windows npm Grok-shim checks remain open. Installed tag/hash/default-ask verification is recorded separately in the handbook's combined-plugin evidence.
