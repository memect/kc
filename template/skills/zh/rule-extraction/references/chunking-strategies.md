# Chunking Strategies for Long Documents

When regulation documents exceed what you can process in a single pass, use these proven strategies to decompose them into manageable chunks while preserving semantic coherence.

## The Onion Peeler (Primary Strategy)

Hierarchical header-based decomposition. Named because you peel the document layer by layer, from the outermost structure inward.

### How It Works

1. **Parse the document's header hierarchy.** Identify all headers by level (H1, H2, H3, etc. — or their equivalents in the document's formatting: "Part I", "Chapter 1", "Section 1.1", "Article 1").
2. **Build a tree.** Each header becomes a node. Content between headers belongs to the nearest preceding header at that level.
3. **Check sizes.** Walk the tree. If a node's content (including all its children) fits within your processing limit, stop — this node is a chunk.
4. **Split only when necessary.** If a node exceeds the limit, descend to its children. Only split when a node is too large AND has sub-headers to split on.
5. **Leaf nodes that are still too large** get handled by the wedge-driving fallback (see below).

### Why This Works

- Respects the document's own semantic structure. A "Chapter 3: Risk Disclosure" chunk contains exactly what the author intended that chapter to contain.
- Minimizes information loss. You never cut in the middle of a thought.
- Produces chunks of varying size — and that is fine. A short chapter is better as one chunk than split into artificial halves.

### Pattern Discovery Shortcut

Before building a full parser, explore several sample documents for structural patterns:
- Do all chapter titles start with "Chapter X" or "第X章"?
- Are sections numbered consistently (1.1, 1.2, 1.3)?
- Are there visual markers (bold text, specific fonts, horizontal rules)?

If you find consistent patterns, a regex-based splitter is faster and more reliable than LLM-based structure detection. For example:
- `^第[一二三四五六七八九十百]+章` for Chinese chapter headers
- `^Chapter \d+` for English chapter headers
- `^\d+\.\d+` for numbered sections

Always validate the regex against multiple documents before committing to it.

## Wedge Driving (Fallback Strategy)

For content without clear headers — dense legal text, continuous prose, or leaf nodes from the onion peeler that are still too large.

### How It Works

The algorithm uses a **rolling context window** to process documents of arbitrary length without loading the full text at once.

**Step 1: Window the content.** Load up to MAX_TOKENS (e.g., 100K tokens — configurable) of the remaining unprocessed text into a window. If the remaining text fits in a single chunk, stop — no further splitting needed.

**Step 2: Ask an LLM for cut points.** Prompt the LLM to identify 1-3 natural break points within the window where topic or subject changes. For each cut point, the LLM returns:
- `tokens_before`: ~K tokens (default K=50) immediately BEFORE the cut, copied verbatim from the text.
- `tokens_after`: ~K tokens immediately AFTER the cut, copied verbatim.
- `chunk_title`: a 5-10 word title describing the chunk that precedes the cut.

Using token count (not word count) gives consistent granularity across languages — critical for Chinese text which has no whitespace-delimited words.

**Step 3: Locate the cuts via fuzzy matching.** The LLM's quoted tokens will not be a perfect match to the source text (minor paraphrasing, whitespace differences, encoding artifacts). Use Levenshtein distance (edit distance) to find the best match:
1. Search the source text for the position that best matches `tokens_before`. Require at least 70% similarity (similarity = 1 - edit_distance / max_length).
2. The cut position is immediately after the matched `tokens_before` region.
3. Verify by checking that `tokens_after` appears near the cut position. If `tokens_after` cannot be matched, fall back to the position derived from `tokens_before` alone.

**Step 4: Slide and repeat.** Create a chunk from the text before the first confirmed cut. Move the window forward: the new window starts from the last cut point. Repeat until all remaining text fits in a single chunk.

### Why This Works

- The LLM identifies semantic boundaries, not arbitrary character counts.
- The LLM never regenerates text — it only quotes positions. No hallucination risk.
- K-token quoting with Levenshtein matching is language-agnostic. It works for Chinese, English, and mixed-language documents equally well.
- The rolling window means documents of any length can be processed incrementally — the algorithm is not bounded by context window size.
- Fuzzy matching handles the inevitable small differences between the LLM's quoted text and the actual source.

### When to Use

- Only when the onion peeler cannot split further (no sub-headers available).
- For documents with no structural markup at all.
- Cost consideration: this requires LLM calls. Use the cheapest model that can identify topic boundaries (often TIER3 or TIER4 is sufficient).

## Practical Guidelines

- **Chunk size depends on the downstream task.** For rule extraction by the coding agent, chunks can be large (100K+ tokens). For worker LLM processing, chunks must fit in 16K-32K context.
- **Preserve context.** When splitting, include the parent header chain as context. A chunk from "Part II > Chapter 3 > Section 3.2" should include those headers so downstream processing knows where the content belongs.
- **Cache the tree.** Once a document's structure is parsed, save the tree. Multiple rules may need content from the same document, and re-parsing is wasteful.
- **Log your chunking decisions.** Which strategy was used, how many chunks were produced, their sizes. This helps debug downstream issues.
