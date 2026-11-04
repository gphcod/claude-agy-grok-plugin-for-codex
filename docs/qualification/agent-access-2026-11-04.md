# Native adviser access — 1.1.9

Windows qualification on 2026-11-04. Efficiency is the highest priority; cooperating agents are assumed to act in good faith. Advice/review scope is expressed in each turn's instructions. Native tools, configured integrations, web search and automatic approvals remain available without plugin tool or directory restrictions. User settings files are not rewritten.

Before this change, Claude/Gemini could not read the sibling Outages repository during a requested LR review. After the change, both read `LR/demand_tool/pure_demands.py` and `7DaySchd/SWP_OP_dev/SWP_OP_YYYYMMDD/scripts/plot_lr_demand_chart.py` and returned exact function names without permission denials:

| Provider | Model / effort | Job | Result |
| --- | --- | --- | --- |
| Claude | haiku / low | `df2831ebeb750dd9` | Both files read, exit 0 |
| Gemini | gemini-3.8-flash / low | `856b12ddba581460` | Both files read, exit 0 |
| Grok | grok-4.7-build-fast / low | Native legacy-session probe | Existing explore session resumed as default; both files read |

The separate Claude-hosted twin also passed Gemini and Codex cross-repository reads. An Argon medium consultation subsequently inspected the app files and returned concrete category-calculation advice. An Opus 5.5 xhigh follow-up reached its 180-second deadline; this is not recorded as a completed review.

Independent source review approved the changes after correcting missing per-turn scope, inherited integrations, legacy Grok resume selection and reporting explicit failed-tool denials. Regression coverage checks fresh/resumed argv, explicit configuration, malformed streams, real provider denials, and bounded process cleanup. Native OS and organization permissions are outside plugin control.

Validation: the full 640-test run had 601 passing, 35 skipped and four stale web-default/skill-budget checks. Those checks passed after correction; the added failed-tool regression also passed. The final tree has 606 passing tests and the same 35 platform/live skips. Plugin validation confirms the 2,998-byte skill; shared-core pins, whitespace and line endings pass.
