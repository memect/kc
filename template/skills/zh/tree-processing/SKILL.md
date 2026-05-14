---
name: tree-processing
tier: meta
description: >
  Design production-grade document chunking mechanisms for verification workflows. Use when
  building the chunking step of a workflow that will run repeatedly on many documents.
  The approach: observe sample documents, find structural patterns, write a chunking script
  in code, that script runs in production. Also use for navigating large documents via
  hierarchical structure when a rule targets a specific section.
  For quick, cheap batch chunking during exploration, use document-chunking instead.
---

# Tree Processing

Most verification rules do not need the entire document. They need a specific section, a specific table, a specific disclosure. The tree is your map for navigating large documents efficiently.

## Production Chunking Methodology

For verification workflows that process many documents, the chunking mechanism must be precise, consistent, and fast. The approach:

1. **Observe**: Read 3-5 sample documents. Note their structure — headers, numbering, section patterns.
2. **Find patterns**: Identify what's consistent (header format, numbering convention, TOC structure).
3. **Write code**: Design a chunking script (regex-based splitter, header detector, TOC parser) that captures the pattern.
4. **Test**: Run the script on samples. Verify it produces correct, consistent chunks.
5. **Deploy**: The script runs in production workflows. It's deterministic, free, and fast.

This is different from `document-chunking` (quick, cheap splits for exploration). Production chunking is a one-time design effort that pays off across all documents of the same type.

## Why Trees

Two reasons:

1. **Rules have scope.** "The risk disclosure in Chapter 5 must contain..." — you need to find Chapter 5, not read 1000 pages.
2. **Worker LLMs have limits.** A 16K-32K context window cannot hold a 1000-page document. You must narrow to the relevant section.

The tree structure solves both: it tells you WHERE things are, and lets you extract JUST what you need.

## Building the Tree

### Step 1: Discover the Structure

Before building a tree parser, explore several sample documents to find structural patterns. Look for:

- **Header conventions**: Do chapters start with "Chapter X"? "第X章"? "Part X"? A Roman numeral?
- **Numbering systems**: "1.1.2", "Article 3", "(a)(i)", hierarchical numbering?
- **Visual markers**: Bold text, larger font, horizontal rules, page breaks before chapters?
- **Table of contents**: Most formal documents have one. It is the document's own tree.

Spend time here. The patterns you find determine whether the tree builder is a simple regex or a complex parser.

### Step 2: Choose the Parser

**If patterns are consistent** (they usually are in regulated documents):
- Write a regex-based splitter. For example:
  - `^第[一二三四五六七八九十百千]+章` for Chinese chapter headers
  - `^Chapter \d+` for English
  - `^\d+\.\d+(\.\d+)*\s` for numbered sections
- This is fast, deterministic, and reliable. Prefer this when it works.

**If patterns are inconsistent or absent**:
- Use the LLM-guided wedge-driving approach (see `rule-extraction/references/chunking-strategies.md` for the full algorithm: rolling context window, K-token quoting, Levenshtein fuzzy matching).
- This is slower and costs LLM calls, but handles unstructured documents. The rolling window means even very large unstructured leaf nodes can be chunked incrementally.

**If the document has a table of contents**:
- Parse the TOC first. It gives you the tree structure and page numbers for free.
- Then use the TOC-derived structure to split the document body.

### Step 3: Build the Tree

The tree is a simple nested structure:

```
Document
├── Part I: General Provisions
│   ├── Chapter 1: Definitions (pages 1-15)
│   └── Chapter 2: Scope (pages 16-22)
├── Part II: Capital Requirements
│   ├── Chapter 3: Minimum Capital (pages 23-45)
│   │   ├── Section 3.1: Tier 1 Capital
│   │   └── Section 3.2: Tier 2 Capital
│   └── Chapter 4: Risk Weighting (pages 46-78)
└── Part III: Disclosure
    └── Chapter 5: Risk Disclosure (pages 79-120)
```

Each node stores: the header text, the level, the start/end positions in the document, and the content size (in tokens or characters).

### Step 4: Use the Tree

Given a rule that says "check the risk disclosure section":

1. **Search the tree** for the relevant node. Match the rule's scope description against node headers.
   - Exact match: "Chapter 5" → find node with "Chapter 5" header.
   - Semantic match: "risk disclosure section" → find node whose header or content relates to risk disclosure. May need fuzzy matching or LLM classification.
2. **Extract the content** of that node (and optionally its children).
3. **Check the size.** If the content fits in the worker LLM's context window, use it directly. If not, descend to child nodes and find the specific subsection needed.

## The Full Context → Chapter → Entity Pipeline

This is the standard narrowing funnel for extracting entities for verification:

1. **Full context**: Use the tree to understand the document structure. Know where everything is.
2. **Chapter**: Navigate to the specific section that the rule targets. Extract its content.
3. **Entity**: Within the chapter content, extract the specific entity (number, text, clause) using the techniques from `entity-extraction`.

For worker LLMs with 16K-32K context:
- The chapter content + the extraction prompt must fit in the context window.
- If a chapter is too large, descend further in the tree.
- Always include the parent header chain for context: "Part II > Chapter 3 > Section 3.1" so the LLM knows where this content sits in the document.

## Caching and Reuse

Build the tree once per document, reuse across all rules:
- Save the tree structure as JSON alongside the parsed document.
- Multiple rules may need different sections of the same document. The tree lets each rule navigate directly to its section without re-parsing.

## Edge Cases

- **Flat documents**: Some documents have no structural hierarchy. Treat the entire document as one node. Use LLM-guided chunking if it exceeds the context window.
- **Deeply nested structures**: Some legal documents have 6+ nesting levels. Build all levels but typically only navigate 2-3 levels deep for any given rule.
- **Cross-section references**: A section might reference "as defined in Section 1.2." When extracting, you may need content from multiple tree nodes. Collect them into a single context for the LLM.
- **Appendices and annexes**: Often contain critical tables and data. Include them as top-level nodes in the tree.
