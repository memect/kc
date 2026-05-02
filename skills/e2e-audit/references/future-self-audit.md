# Future direction: KC self-audit during production_qc / finalization

This skill is currently for Claude (the human's auditor) reviewing a
finished KC session. The user has signaled interest in eventually
distilling it into a skill KC itself can use, in production_qc or as
an explicit pre-finalization gate. Here's the design space.

## The shape of a KC self-audit skill

A KC-facing version would be much smaller than the auditor-facing one.
KC already has the workspace open; it doesn't need to learn how to
locate `events.jsonl`. The teaching it needs is mostly methodological:

1. **Trust the disk, not your narrative.** Re-read `manifest.json`,
   `catalog.json`, the most recent `output/qc_batch_results.json`.
   Don't summarize from memory of what you wrote earlier. Discrepancies
   between your AGENT.md and the manifest are a signal.

2. **Cross-check seeded violations.** If the test corpus has
   ground-truth-labeled samples (filename prefixes like `非我行托管`,
   `信保基金有误`, `一致：`), explicitly verify your skills fired
   correctly on them. Don't grade only on aggregate pass rates.

3. **Distinguish autonomous from prompted.** Re-read the user_message
   stream in `events.jsonl`. For each prompt, ask: did this prompt
   change my final architecture? If yes, the win belongs partly to
   the prompt. Note this in the release notes — it sets correct
   expectations for whether the result reproduces autonomously.

4. **Honest false-positive / false-negative reporting.** A 90% pass
   rate that hides 4/4 false positives on a control sample is worse
   than an 85% pass rate honestly reported. The release notes should
   say "94% custodian accuracy with 1 false positive on 一致 control
   for trust_security_fund check (regex too broad — see corner_cases.json)"
   not "94% accuracy ✅".

5. **Version-string and metadata sanity.** Before finalization, grep
   own outputs for stale version strings (any "0.5.x" / "0.6.x" in
   manifests if KC is at 0.7.x). Most leaks are hardcoded engine
   defaults; flag them rather than ship them.

## What this skill should NOT teach KC

- **Process trace from events.jsonl.** KC doesn't need to read its own
  process log; the engine surfaces phase state through describeState.
- **Comparative scorecards across versions.** KC doesn't know what
  version it's running unless told. Cross-version comparison is the
  human's job.
- **Bug-hunting in the engine.** KC files bugs against itself by
  writing to `logs/` notes. The engine team triages them; KC doesn't.

## When to extract this skill

Pre-conditions before turning this into a KC-facing skill:

1. Run this auditor-facing skill on at least 3 more E2E sessions and
   refine the methodology based on what surfaces.
2. Identify which audit sub-checks are *self-correcting* (e.g.,
   "your manifest version is stale" — KC can fix this) vs which are
   *human-only* (e.g., "Group X teaching didn't land" — needs
   version-plan revision).
3. Carve the self-correcting subset into a slimmer skill,
   `meta-meta/self-audit` perhaps, that KC reads at the start of
   `production_qc` (not finalization — too late then).
4. Test it on a fresh session and check whether KC's
   self-audit catches things the human auditor would catch.

If KC's self-audit consistently catches bugs the human auditor would
have caught, the skill works. If KC self-audits but misses obvious
issues, the skill needs more concreteness or a different framing.

## What to keep separate

The bug-finding parts of audits (hardcoded versions, router misses,
empty calibration files) are best handled by static analysis and
unit tests, not by a runtime skill. KC's self-audit should focus on
*the work product* (rules, skills, workflows, release notes), not
on engine plumbing.
