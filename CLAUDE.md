# Claude Notes — KC CLI Project

Notes for me (Claude) working in this repository. Distinct from
`template/CLAUDE.md`, which is the workspace-template KC creates inside
each verification project.

## Custom skills live at `skills/`

The user has scaffolded `skills/` for me to put working skills that
encode methodology we develop together. Currently:

- `skills/e2e-audit/` — for auditing finished KC E2E test sessions.
  Read its SKILL.md when the user asks to audit/review a finished
  bench session, compare two runs, or evaluate whether a v0.7.x
  Group N fix landed.

These skills are **living documents.** KC's engine, teaching, and
tooling evolve between versions. Each skill should be updated when:

- A KC engine feature changes the events.jsonl shape, deliverable
  paths, or phase model
- A new release adds Group N teaching changes that the skill's
  scorecard section should track
- A real audit surfaces a check we should have done but didn't —
  add it to the methodology
- A cross-cutting bug recurs — promote it from one-off finding to a
  scripted check

The bar for adding to a skill: would a future auditor actually use
this? If yes, add it. If no, leave it in the per-run doc.

## Audit doc convention

Audit-related artifacts go under `archive/`:

- `e2e_test_<YYYYMMDD>_v<NNN>_observations.md` — live observations
  during a run (pre-audit notes)
- `e2e_test_<YYYYMMDD>_v<NNN>_<conductor>_session_audit.md` —
  per-conductor substance audit
- `e2e_test_<YYYYMMDD>_v<NNN>_session_audit.md` — combined
  cross-session synthesis (no conductor suffix)

## Project context shorthand

- KC = the Node CLI agent under development at this repo. Document
  verification agent. Phases: bootstrap → rule_extraction →
  skill_authoring → skill_testing → distillation → production_qc →
  finalization.
- v0.7.1 (current) = patches on v0.7.0 covering Group 1 (engine),
  Group 2 (gate nudges), Group 3 (skill teaching). Tag at
  `91089c2`.
- E2E #7 = the v0.7.1 verification run started 2026-05-01 with
  parallel DS + GLM sessions on `archive/test_data_3_lite/`. Both
  reached finalization. Audits filed.
