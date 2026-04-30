"""KC release runtime — v1.

Minimal Python helpers used by run.py to dispatch verification
workflows. Designed to be drop-in self-contained: stdlib + a handful
of optional native parsers (pypdf, python-docx) for document
parsing. Falls back to plaintext + LibreOffice CLI if natives
unavailable — never crashes the run on a missing dep.
"""

__version__ = "1.0.0"
__all__ = ["doc_parser", "confidence"]
