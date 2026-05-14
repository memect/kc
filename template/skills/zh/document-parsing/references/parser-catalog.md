# Parser Catalog

## Text-Based Parsers (No LLM Required)

| Parser | Type | Strengths | Limitations | Install |
|--------|------|-----------|-------------|---------|
| PyMuPDF (fitz) | Text extraction | Fast, reliable, basic structure | No table awareness, no OCR | `pip install pymupdf` |
| pdfplumber | Layout-aware | Good table detection, spatial layout | Text-only, no OCR | `pip install pdfplumber` |
| python-docx | DOCX parser | Native DOCX support, preserves structure | DOCX only | `pip install python-docx` |
| openpyxl | XLSX parser | Full spreadsheet support | XLSX only | `pip install openpyxl` |
| MarkItDown | Multi-format | Handles PDF, DOCX, PPTX, XLSX → markdown | Basic parsing, may miss complex layouts | `pip install markitdown` |

## OCR / Vision Models (Via SiliconFlow API)

| Model | Tier | Strengths | Best For |
|-------|------|-----------|----------|
| zai-org/GLM-4.6V | OCR_TIER1 | Best accuracy, strong Chinese OCR | Complex tables, mixed layouts |
| Qwen/Qwen3.5-397B-A17B | OCR_TIER2 | Good general vision, large model | Tables with context-dependent interpretation |
| PaddlePaddle/PaddleOCR-VL-1.5 | OCR_TIER3 | Fast, lightweight | Standard text, simple tables |

## Local Deployment Options

For developer users who prefer local processing:

| Tool | Type | Notes |
|------|------|-------|
| PaddleOCR | Local OCR | Open source, supports Chinese/English |
| Surya | Local OCR | Modern OCR with table detection |
| pdf2md-local | PDF → Markdown | Reference: github.com/Ruilin-mmwa/pdf2md-local |

## Selection Decision Tree

```
Is the PDF text-based (not scanned)?
├─ Yes → PyMuPDF or pdfplumber
│   └─ Are tables parsed correctly?
│       ├─ Yes → Done
│       └─ No → Try pdfplumber → If still bad → Vision model on table regions
└─ No (scanned) → OCR_TIER3 → If quality insufficient → OCR_TIER1
```
