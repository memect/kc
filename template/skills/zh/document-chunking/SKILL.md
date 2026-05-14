---
name: document-chunking
tier: meta
description: >
  Fast, cheap chunking for processing batches of sample and input documents.
  Use when you need to split documents into manageable pieces for initial observation,
  data sensibility checks, or feeding to extraction workflows. Not for production
  verification chunking — for that, use tree-processing to design a tailored chunking script.
---

# Document Chunking

Split documents into pieces for downstream processing. This is the fast, cheap version — for batch processing of samples and inputs, not for precision verification workflows.

## Methods

**Page-level splits** — simplest. Each page is a chunk. Works for most document processing where you need to iterate over content.

**Fixed-size chunks** — split by character/token count with overlap. Good for search and initial observation. Typical: 2000-4000 chars with 200 char overlap.

**Header-based splits** — detect section headers and split at boundaries. Preserves semantic units. Use regex patterns for the document's header convention.

## When to Use What

Pick the simplest method that serves the task:
- Batch document observation → page-level
- Full-text search index → fixed-size with overlap
- Section-level extraction → header-based
- Table of contents available → parse TOC for structure

## Relationship to tree-processing

This skill is for quick, cheap chunking during exploration and batch processing. When you need production-grade chunking for verification workflows — where the chunking mechanism must be precise, consistent, and coded as a script — use `tree-processing` instead.
