---
name: document-chunking
tier: meta
description: >
  Split documents into chunks for downstream processing. Use when batching samples
  for observation, feeding extraction workflows, or breaking long regulation documents
  into pieces small enough to fit a worker LLM. Covers cheap methods (page, fixed-size,
  header-based) for quick exploration AND the onion-peeler hierarchical strategy +
  wedge fallback for production-grade chunking of long structured documents. Also
  covers the central balance question: chunk-too-big (information lost in a haystack)
  vs. chunk-too-small (semantic continuity broken).
---

# Document Chunking

Split documents into pieces for downstream processing. Two regimes:

- **Cheap chunking** — fast methods for batch observation and
  exploratory processing of samples.
- **Hierarchical chunking** — the onion-peeler strategy (borrowed
  from pdf2skills' methodology) for long structured documents where
  semantic boundaries matter, with the wedge fallback for stretches
  that have no headers.

The most important question across both regimes: **how big should a
chunk be**? See "Finding the balance" below before settling on
specific sizes.

## Quick Methods

**Page-level splits** — simplest. Each page is a chunk. Works for
most document processing where you need to iterate over content.

**Fixed-size chunks** — split by character or token count with
overlap. Good for search and initial observation. Typical: a few
thousand chars with modest overlap to keep cross-boundary phrases
recoverable.

**Header-based splits** — detect section headers and split at
boundaries. Preserves semantic units. Works when the document has a
consistent header convention you can express as regex.

## Onion Peeler — Hierarchical Strategy (primary for long structured docs)

Hierarchical, header-based decomposition. Called "onion peeler"
because you peel the document layer by layer, from the outermost
structure inward.

### How it works

1. **Parse the document's heading hierarchy.** Identify all headers
   at every level (H1, H2, H3 — or the document's equivalent: "Part I",
   "Chapter 1", "Section 1.1", "Article 1").
2. **Build a tree.** Each header is a node. Content between headers
   belongs to the nearest ancestor.
3. **Check size.** Walk the tree. If a node's content (including all
   descendants) fits within the processing budget, stop there — that
   node is one chunk.
4. **Descend only when needed.** If a node is over budget, descend
   into its children. Only split when the node is genuinely too large
   AND has sub-headers available.
5. **Leaf nodes still over budget** → hand off to the wedge fallback.

### Why it works

- Respects the document's own semantic structure. "Chapter 3 — Risk
  Disclosure" stays as one chunk because that's how the author
  intended it.
- Minimizes information loss. Never cuts mid-meaning.
- Produces variable-size chunks — and that's a feature. A short
  chapter as one whole chunk is better than the same chapter forcibly
  split in half.

### Shortcuts for pattern discovery

Before building a full parser, explore structural patterns on a few
sample documents:
- Do all chapter headers start with "Chapter X" or "第X章"?
- Is section numbering consistent (1.1, 1.2, 1.3)?
- Are there visual markers (bold, specific font, horizontal rules)?

If you find a stable pattern, a regex-based chunker is faster and
more reliable than LLM-based structure detection. Examples:
- `^第[一二三四五六七八九十百]+章` matches Chinese chapter headers
- `^Chapter \d+` matches English chapter headers
- `^\d+\.\d+` matches numbered subsections

Validate the regex on multiple documents before relying on it.

## Wedge Fallback (for content without clear headers)

For dense legal text, continuous prose, or onion-peeler leaf nodes
that are still too large with no sub-headers to descend into.

### How it works

Uses a **rolling context window** so the algorithm scales to documents
of arbitrary length.

1. **Window the content.** Load up to MAX_TOKENS of unprocessed text
   into a window (configurable; pick a size your LLM can comfortably
   read).
2. **Have the LLM mark cut points.** Prompt the LLM to identify 1-3
   natural breakpoints in the window where topic / subject shifts.
   For each cut point, the LLM returns:
   - `tokens_before`: ~K tokens (e.g., K=50) preceding the cut, quoted
     verbatim from the source.
   - `tokens_after`: ~K tokens following the cut, quoted verbatim.
   - `chunk_title`: a short title (5-10 chars) for the chunk before
     the cut.
3. **Locate cuts via fuzzy match.** The LLM's quoted tokens won't
   match the source exactly (minor rewording, whitespace differences).
   Use Levenshtein distance to find the best position. Require a
   reasonable similarity threshold; fall back to `tokens_before`-only
   matching if `tokens_after` can't be located.
4. **Slide and repeat.** Cut the text before the first confirmed
   breakpoint as a chunk. Slide the window to start at the cut point.
   Repeat until the remaining text fits in a single chunk.

### Why it works

- LLM identifies semantic boundaries, not arbitrary character
  positions.
- LLM doesn't regenerate text — it only quotes positions. No
  hallucination risk.
- Token-quote + Levenshtein matching is language-agnostic: works on
  Chinese, English, mixed-language docs.
- Rolling window scales to any document length.
- Fuzzy matching handles inevitable small differences between
  LLM-quoted text and source.

### When to use it

- Only when onion-peeler can't proceed (no sub-headers available).
- For unstructured documents with no formal markers.
- Cost-aware: this method calls the LLM. Pick the cheapest model
  that can identify topic boundaries (typically tier 3 or 4 is
  enough).

## Finding the balance — when to stop splitting

The two failure modes:

- **Chunks too big**: relevant content gets buried in a haystack
  inside the LLM's context. Even within the LLM's window, attention
  spreads thin across long inputs — the longer the chunk, the more
  likely the actual evidence is missed.
- **Chunks too small**: semantic continuity breaks. A rule that
  needs "the company is a bank" + "the loan exceeds threshold X" to
  fire might see those facts split across chunks and lose the
  conjunction.

How to find the balance:

1. **Anchor on the downstream task, not the LLM's context window.**
   The chunk should be large enough to contain the evidence a
   downstream rule needs in one piece. If a rule needs to compare
   two clauses, those clauses must end up in the same chunk.
2. **Use semantic boundaries over fixed sizes.** A chunk that ends
   at a section boundary is more useful than a chunk that hit a
   target token count mid-sentence. Onion-peeler stops where the
   document stops; lean on that.
3. **Test with the actual downstream consumer.** Run a sample
   extraction or judgment on the chunked output. If the consumer
   misses evidence that's present in the source, your chunks are
   wrong shape — usually too big or split at the wrong boundary.
4. **Track variance, not just average size.** A handful of giant
   chunks among many small ones is more of a problem than a uniform
   distribution at any reasonable size. The big ones are where you'd
   lose information.
5. **Don't optimize blindly for the LLM's context window.** A 128K
   context model can technically swallow a 100K chunk; the attention
   to retrieve specific evidence from that chunk is a different
   question. Smaller, well-bounded chunks usually win.

## Practical Tips

- **Chunk size depends on the downstream task.** Rule extraction by
  the coding agent can take very large chunks. Worker LLM verification
  needs chunks that comfortably fit inside its context with room for
  prompt + response.
- **Preserve context.** When splitting, carry the parent header chain
  as context. A chunk from "Part II > Chapter 3 > Section 3.2"
  should include those headers so the downstream consumer knows where
  it sits.
- **Cache the chunk tree.** Once a document's structure is parsed,
  save the tree. Many rules may need the same document's content;
  re-parsing is waste.
- **Log chunking decisions.** Which strategy was used, how many
  chunks were produced, what the size distribution looks like.
  Helpful for downstream debugging.

## Relationship to tree-processing

This skill covers chunking methods. `tree-processing` covers
designing the precise, coded chunking script for production
verification workflows — where chunking must be deterministic,
reproducible, and tested. Reach for `tree-processing` when the cheap
methods above don't give you enough control for the production path.
