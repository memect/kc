# Convergence Guide

Diagnostic procedures and real-world data for understanding when the evolution loop is converging, stalling, or regressing.

## Empirical Data

### The Shiji Project — Event Dating Reflection

A document verification project for historical event dating across regulatory filings. Five rounds of evolution:

- **Round 1**: 1,010 corrections (first pass — many extraction and judgment errors across the board).
- **Round 2**: 431 corrections (systematic fixes applied — regex patterns, prompt refinements).
- **Round 3**: 465 corrections (regression — round 2 fix for date normalization introduced new failures on edge-case date formats).
- **Round 4**: 167 corrections (stabilizing — round 3 regression diagnosed and resolved, remaining issues are corner cases).
- **Round 5**: 46 corrections (converged — below 5% threshold, no new patterns, no regressions).

**Key insight**: The round 3 spike was the most informative event. It revealed that the round 2 fix was too aggressive — it normalized dates that should not have been normalized. Without convergence tracking, this regression might have been masked by overall accuracy still improving on other cases.

## Diagnostic Flowchart

### If correction volume increases between iterations:

1. **Check for regression**: Are previously passing cases now failing? If yes, the last fix is the likely cause. Compare the diff between iterations.
2. **Check for fix conflicts**: Does the new fix contradict a prior fix? For example, broadening a regex in round N that was narrowed in round N-1.
3. **Check for test set changes**: Did new documents enter the test set between iterations? New documents can inflate correction volume without indicating regression.

### If correction volume stays flat (not decreasing):

1. **Check for oscillation**: Are the same cases flipping between pass and fail across iterations? This indicates the fix is unstable — it solves one variant but breaks another.
2. **Check if fix is too narrow**: The fix addresses the specific failing cases but does not generalize. The next iteration reveals similar cases the fix missed.

## False Convergence

Metrics look stable but underlying issues are masked. The system appears converged but will fail on production data.

### Common Causes

- **Test set too small**: With fewer than 20 test cases, a single case changing can swing metrics by 5%. Convergence at this scale is statistically meaningless.
- **Test set does not cover production variety**: The test set was curated from "clean" examples. Production documents include scanned PDFs, handwritten annotations, multi-language content, and formatting variations the test set never saw.
- **Corner cases excluded from metrics**: If difficult cases are moved to `corner_cases.json` and excluded from accuracy calculation, the remaining "easy" cases converge quickly but the real problem is hidden.

### Detection

Compare test set distribution to production distribution on key dimensions: document type, length, format, source. If they diverge significantly, convergence on the test set does not guarantee production quality.

## Estimating Remaining Rounds

### Simple Heuristic

If corrections approximately halve each round, expect `log2(current_corrections / threshold)` more rounds.

Example: current round has 200 corrections, threshold is 5% of 1000 cases = 50 corrections.
- Estimated remaining rounds: log2(200/50) = log2(4) = 2 rounds.

### When the Heuristic Fails

If corrections do not halve between rounds, the current approach may have hit its ceiling. Consider:
- Escalating the fix strategy (prompt tweak → logic rewrite → architecture change).
- Expanding the test set to reveal hidden patterns.
- Consulting the developer user for domain insight on stubborn failures.

Do not grind through more iterations expecting different results. If three consecutive rounds show similar correction volumes, stop and reassess.
