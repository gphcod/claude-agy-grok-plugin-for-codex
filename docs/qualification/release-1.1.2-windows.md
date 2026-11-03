# 1.1.2 Windows release qualification

Owner date: 2026-11-02 Pacific; raw records use UTC. Runtime/test source: `543ea5ddb80e397dee3b2659886a929c962df209`; later qualification-only commits do not change plugin bytes.

`npm run validate` passes: **585 total, 549 pass, 36 platform skips, zero failures**, 313,059 ms. Metadata, README and skill checks pass; the skill is 2,987 B with a 128 B description. Nine local core pins match; full cross-host comparison remains deferred.

Eighteen new publication regressions cover real Windows FileShare.Read locks, full entry plus same-id replay with one provider submission, monotonic stage reads, flush ordering, generation changes, competing cleanup, marker restoration and preparation racing cleanup. [Lock qualification](windows-request-lock.md) includes actual previous/current-client interoperability with retained and pruned job bodies. Root and stage helpers are byte-identical across hosts; complete host job modules are not claimed identical.

All six final real-host/fake-Gemini recovery/outage/partial cases pass on this payload, with confirmed cleanup and zero Claude permission denials. [Service qualification](gemini-service-recovery.md) separates those functional cases from backend availability and timing claims. Per-turn contracts, permission recipes, CLI carriers and default models remain unchanged; the earlier 31 shell call-form checks remain their separately dated record.

The 1.1.0 runtime/host-collection studies remain historical and are not relabelled as a new patch benchmark. Extra request metadata names, reads and flushes are explicit costs. Exact-payload macOS, desktop discovery/wake, Windows npm Grok-shim and Windows full-machine power-loss recovery remain unqualified. Installed tag/hash/default-ask verification is recorded separately in the handbook. No hosted CI was used.
