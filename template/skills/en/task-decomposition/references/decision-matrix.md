# Decision Matrix for Method Selection

This reference provides the detailed decision matrix for assigning methods to sub-tasks during task decomposition. Read `task-decomposition` SKILL.md first for the philosophy; this document is the operational reference.

## The Four Dimensions

| Dimension | Definition | 1 (Low) | 3 (Medium) | 5 (High) |
|---|---|---|---|---|
| **Certainty** | Predictability of input format and location | Free-form prose, no fixed structure | Semi-structured with known sections but variable formatting | Fixed template, exact field positions |
| **Scale** | Number of items to process per document | 1-5 items | 10-100 items | 1,000+ items |
| **Semantic Depth** | Language understanding required | None — pure pattern or numeric | Moderate — entity recognition, simple context | Deep — judgment, adequacy assessment, intent interpretation |
| **Cost Sensitivity** | Budget constraint per document | Unlimited (one-off audit) | Moderate (monthly batch of hundreds) | Tight (daily batch of thousands) |

## Method Assignment Rules

Use the highest-priority method whose requirements are met. Priority order: Rule/Regex > Code > LLM > Manual.

| Certainty | Scale | Semantic Depth | Cost Sensitivity | Assigned Method | Rationale |
|---|---|---|---|---|---|
| High (4-5) | Any | Low (1-2) | Any | **Rule / Regex** | Predictable input + no language understanding = deterministic pattern matching |
| High (4-5) | Any | Low (1-2) | Any | **Code / Python** | Calculations, comparisons, transformations on structured data |
| Medium (3) | High (4-5) | Low (1-2) | High (4-5) | **Code + Regex** | Volume demands speed; invest in parsing code to avoid per-item LLM cost |
| Medium (3) | Low (1-2) | Medium (3) | Low (1-2) | **LLM** | Moderate understanding needed, low volume makes LLM cost acceptable |
| Low (1-2) | Any | High (4-5) | Any | **LLM** | Deep semantic understanding has no cheaper alternative |
| Low (1-2) | High (4-5) | High (4-5) | High (4-5) | **LLM (low tier) + sampling** | Volume + semantics + budget = use cheapest LLM, sample-verify with higher tier |
| Any | Any | Any | — | **Manual** | Last resort when automated methods fail accuracy threshold |

The table covers common patterns, not every combination. When a sub-task falls between categories, test both candidate methods on a sample and measure accuracy and cost. Let data decide.

## Worked Example: Cross-Field Validation

**Rule**: "The loan amount must not exceed 70% of the appraised collateral value."

Decomposition into sub-tasks with method assignments:

| # | Sub-task | Input | Output | Method | Rationale |
|---|---|---|---|---|---|
| 1 | Locate loan amount field | Full document text | Page/section reference | LLM (Tier 3) | Field position varies across document types |
| 2 | Extract loan amount | Located section text | Numeric value (float) | Regex | Amount follows pattern: ¥/$/digits with commas |
| 3 | Locate collateral section | Full document text | Page/section reference | LLM (Tier 3) | Section name varies: "Collateral", "Security", "Pledged Assets" |
| 4 | Extract appraised value | Located section text | Numeric value (float) | Regex + Code | Regex extracts; code handles unit conversion (万/亿) |
| 5 | Calculate threshold | Loan amount, collateral value | 70% threshold value | Code | Pure arithmetic: `collateral * 0.70` |
| 6 | Compare | Loan amount, threshold | Pass/Fail | Code | Simple comparison: `loan_amount <= threshold` |
| 7 | Generate comment | All extracted values | Comment string | Code (template) | Template: "Loan amount {X} is {above/within} 70% of collateral value {Y} (threshold: {Z})" |

LLM calls: 2 (locate steps only). Everything else is regex or code. Total LLM cost per document: ~0.002 USD at Tier 3 pricing.

## Worked Example: Large-Scale Filtering

**Task**: Match 31,800 invoices against 15,940 contracts to find which invoices belong to which contracts.

Naive approach: 507M pairwise LLM comparisons. Estimated cost: $50,000+. Time: weeks.

Layered decomposition:

| Layer | Method | Input Size | Output Size | Reduction | Cost |
|---|---|---|---|---|---|
| 1. Exact match on supplier name + contract number | Rule/Regex | 507M pairs | 25,200 matches | 99.5% eliminated | ~$0 |
| 2. Fuzzy match on amount range (±5%) + date overlap | Code | Remaining unmatched pairs | 12,400 candidates | 97.6% of remainder eliminated | ~$0 |
| 3. Semantic comparison of line-item descriptions | LLM (Tier 3) | 12,400 candidates | 7,652 confirmed | Final precision filter | ~$25 |
| 4. Manual review of low-confidence matches | Manual | ~200 uncertain | ~200 resolved | Edge cases | ~$100 (labor) |

Total cost: ~$125. Time: hours. Same accuracy as the naive approach.

The key insight: each layer's method is chosen because it is the cheapest method that can reliably make the distinctions required at that stage.

## Cost Estimation Template

Use this template during decomposition planning to estimate per-document cost.

| Sub-task | Method | Est. Cost/Call | Calls/Document | Subtotal |
|---|---|---|---|---|
| Locate section | LLM Tier 3 | $0.001 | 2 | $0.002 |
| Extract fields | Regex | $0.000 | 5 | $0.000 |
| Normalize values | Python | $0.000 | 5 | $0.000 |
| Cross-field comparison | Python | $0.000 | 1 | $0.000 |
| Semantic judgment | LLM Tier 2 | $0.003 | 1 | $0.003 |
| Comment generation | Template | $0.000 | 1 | $0.000 |
| **Total per document** | | | | **$0.005** |

Multiply by expected document volume to get batch cost. Compare against the developer user's budget. If total exceeds budget, optimize the most expensive sub-tasks first — usually the LLM calls with the highest per-call cost or the highest call count.
