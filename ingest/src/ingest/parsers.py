"""File → plain text for lesson-docs. Supported: .md, .txt, .pdf, .html/.htm."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from bs4 import BeautifulSoup
from pypdf import PdfReader

from .chunker import normalize

SUPPORTED = {".md": "md", ".txt": "txt", ".pdf": "pdf", ".html": "html", ".htm": "html"}
SHELL_PAGE_MIN_CHARS = 200  # below this, a saved HTML page is an app shell; look in its _files folder


@dataclass(frozen=True)
class ParsedDoc:
    title: str
    source_type: str
    text: str


def _stem_title(path: Path) -> str:
    return re.sub(r"[_\-]+", " ", path.stem).strip()


def _html_text(raw: str) -> tuple[str | None, str]:
    soup = BeautifulSoup(raw, "html.parser")
    title = soup.title.get_text(strip=True) if soup.title else None
    for tag in soup(["script", "style", "noscript", "template"]):
        tag.decompose()
    return title, normalize(soup.get_text("\n"))


def parse_html(path: Path) -> ParsedDoc:
    title, text = _html_text(path.read_text(encoding="utf-8", errors="ignore"))
    if len(text) < SHELL_PAGE_MIN_CHARS:
        companion = path.with_name(f"{path.stem}_files")
        if companion.is_dir():
            best = text
            for f in sorted(companion.glob("*.htm*")):
                _, t = _html_text(f.read_text(encoding="utf-8", errors="ignore"))
                if len(t) > len(best):
                    best = t
            text = best
    return ParsedDoc(title or _stem_title(path), "html", text)


def parse_pdf(path: Path) -> ParsedDoc:
    reader = PdfReader(str(path))
    pages = [(p.extract_text() or "") for p in reader.pages]
    return ParsedDoc(_stem_title(path), "pdf", normalize("\n\n".join(pages)))


def parse_markdown(path: Path, source_type: str) -> ParsedDoc:
    text = path.read_text(encoding="utf-8", errors="ignore")
    m = re.search(r"^#\s+(.+)$", text, flags=re.MULTILINE)
    title = m.group(1).strip() if (m and source_type == "md") else _stem_title(path)
    return ParsedDoc(title, source_type, normalize(text))


def parse_file(path: Path) -> ParsedDoc | None:
    """Returns None for unsupported file types (e.g. images)."""
    kind = SUPPORTED.get(path.suffix.lower())
    if kind is None:
        return None
    if kind == "pdf":
        return parse_pdf(path)
    if kind == "html":
        return parse_html(path)
    return parse_markdown(path, kind)
