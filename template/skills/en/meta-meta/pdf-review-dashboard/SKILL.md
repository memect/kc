---
name: pdf-review-dashboard
description: >
  Generate a two-column PDF review dashboard for manual verification result checking.
  Left panel shows the original PDF document, right panel shows verification results.
  Clicking a result jumps the PDF to the relevant page. Use this when the developer user
  needs to visually compare verification outputs against source documents, or when
  collecting ground truth for the evolution loop. Output is a single self-contained HTML file.
---

## What It Does

Generates a single self-contained HTML file that displays:
- Left: original PDF rendered in-browser
- Right: verification results in an interactive list
- Click-to-jump: selecting a result scrolls the PDF to the referenced page

The developer user opens this HTML in a browser to manually review verification quality.

## Tech Stack

- Single HTML file, no server required
- PDF embedded as base64 (fully self-contained, shareable)
- pdf.js via CDN for in-browser PDF rendering
- Vanilla JS + inline CSS, no framework dependencies
- Dark theme consistent with KC dashboard style

## Layout

- Resizable split pane with draggable divider
- Left: PDF viewer with page navigation (prev/next/go-to-page) and zoom controls (+/-/fit-width)
- Right: results list with filter buttons, click to expand details and jump to PDF page
- Page highlight animation on jump

## Data Format

The generator script reads a PDF file and a results JSON, then produces the HTML.

Input to the script:
- `pdf_path` — path to the source PDF document
- `results_path` — path to a JSON file containing verification results

The results JSON is an array of objects. Each object should have at minimum:
- A page reference (which page in the PDF this result relates to)
- A result status (pass/fail/warning or equivalent)

The right panel columns and detail fields adapt to whatever data the verification workflow produces. The script in `scripts/generate_review.js` is a reference implementation — adapt the data mapping to match your project's output format.

## When to Use

- After a verification workflow completes, to let the developer user visually audit results
- When collecting ground truth corrections for the evolution loop
- When presenting results to stakeholders who need to see source evidence

## Generator Script

See `scripts/generate_review.js` — a Node.js script that takes a PDF path and outputs the review HTML. Adapt the results data mapping section to match your project's verification output format.
