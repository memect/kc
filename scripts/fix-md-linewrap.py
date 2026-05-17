#!/usr/bin/env python3
"""
Fix fixed-width line wrapping in markdown files.

Heuristic: identify paragraphs (blank-line-separated blocks) that are
plain prose — not code blocks, not lists, not tables, not headings, not
HTML — and join their hard-wrapped lines into a single line per
paragraph. Lists and tables are joined per-item too if they wrap.

Skip: lines inside ``` fenced code, ~~~ fenced code, indented
4-space code blocks, HTML blocks, frontmatter (--- ... ---), tables
(lines starting with |).

Usage: python3 scripts/fix-md-linewrap.py <file.md> [<file2.md> ...]
"""
import sys
import re
from pathlib import Path


def is_heading(line: str) -> bool:
    return line.lstrip().startswith("#")


def is_list_item_start(line: str) -> bool:
    s = line.lstrip()
    return bool(re.match(r"^(-|\*|\d+\.|>)\s", s))


def is_table_row(line: str) -> bool:
    return line.lstrip().startswith("|")


def is_blank(line: str) -> bool:
    return line.strip() == ""


def is_fence_open(line: str) -> bool:
    s = line.lstrip()
    return s.startswith("```") or s.startswith("~~~")


def looks_like_html(line: str) -> bool:
    s = line.lstrip()
    return bool(re.match(r"<[a-zA-Z!/]", s))


def fix_file(path: Path) -> tuple[int, int]:
    """Returns (lines_before, lines_after)."""
    text = path.read_text(encoding="utf-8")
    lines = text.split("\n")
    out: list[str] = []
    i = 0
    in_fence = False
    fence_marker = ""
    in_frontmatter = False
    if lines and lines[0].strip() == "---":
        in_frontmatter = True
        out.append(lines[0])
        i = 1

    while i < len(lines):
        line = lines[i]

        # Frontmatter pass-through
        if in_frontmatter:
            out.append(line)
            if line.strip() == "---":
                in_frontmatter = False
            i += 1
            continue

        # Code fence open/close — pass through verbatim
        if is_fence_open(line):
            if not in_fence:
                in_fence = True
                fence_marker = line.lstrip()[:3]
            elif line.lstrip().startswith(fence_marker):
                in_fence = False
                fence_marker = ""
            out.append(line)
            i += 1
            continue

        if in_fence:
            out.append(line)
            i += 1
            continue

        # Blank, heading, table, indented code (4 leading spaces) — pass
        if is_blank(line) or is_heading(line) or is_table_row(line):
            out.append(line)
            i += 1
            continue
        if line.startswith("    ") and (i == 0 or is_blank(lines[i - 1])):
            # Indented code block start
            out.append(line)
            i += 1
            continue
        if looks_like_html(line):
            out.append(line)
            i += 1
            continue

        # We're at the start of a prose paragraph OR a list item.
        # Collect continuation lines: non-blank, non-heading, non-fence,
        # non-table, that are NOT new list items themselves (those would
        # start a new bullet).
        is_list = is_list_item_start(line)
        para_lines = [line]
        j = i + 1
        while j < len(lines):
            nxt = lines[j]
            if is_blank(nxt) or is_heading(nxt) or is_table_row(nxt) \
                    or is_fence_open(nxt) or looks_like_html(nxt):
                break
            # New list item starts? Stop joining (this is a new bullet).
            if is_list_item_start(nxt):
                # But: if this is INSIDE the current list item (indented
                # continuation that looks like "- X"), the indent would
                # mark it. The heuristic "starts with - " catches both
                # new bullets and indented bullets. Treat any bullet
                # line as a new item.
                break
            # Indented continuation? In Markdown, indented continuation
            # of a list item also counts. Join it but preserve the
            # logical structure (just remove the linebreak).
            para_lines.append(nxt)
            j += 1
        # Join the paragraph: replace internal newlines with separator.
        # For CJK-to-CJK boundaries, use empty string (no space between
        # Chinese chars). For all other boundaries, use single space.
        if len(para_lines) == 1:
            out.append(para_lines[0])
        else:
            cleaned = [p.rstrip() for p in para_lines]
            # Also strip leading whitespace from continuation lines
            # (they typically have 0 leading whitespace already, but be safe)
            cleaned = [cleaned[0]] + [p.lstrip() for p in cleaned[1:]]
            buf = cleaned[0]
            cjk_re = re.compile(r"[　-鿿＀-￯]")
            for nxt in cleaned[1:]:
                if not nxt:
                    continue
                left_char = buf[-1] if buf else ""
                right_char = nxt[0]
                # CJK on both sides → no separator
                if cjk_re.match(left_char) and cjk_re.match(right_char):
                    buf += nxt
                else:
                    buf += " " + nxt
            # Collapse any double-spaces
            buf = re.sub(r"  +", " ", buf)
            out.append(buf)
        i = j

    new_text = "\n".join(out)
    # Preserve trailing newline if original had one
    if text.endswith("\n") and not new_text.endswith("\n"):
        new_text += "\n"
    path.write_text(new_text, encoding="utf-8")
    return len(lines), len(out)


def main():
    if len(sys.argv) < 2:
        print("usage: python3 fix-md-linewrap.py <file.md> [<file2.md> ...]")
        sys.exit(1)
    total_before = total_after = 0
    for arg in sys.argv[1:]:
        p = Path(arg)
        if not p.exists() or p.suffix != ".md":
            print(f"  skip {arg} (not a .md file or not found)")
            continue
        before, after = fix_file(p)
        total_before += before
        total_after += after
        print(f"  {arg}: {before} → {after} lines ({before - after} merged)")
    print(f"\nTotal: {total_before} → {total_after} lines ({total_before - total_after} merged)")


if __name__ == "__main__":
    main()
