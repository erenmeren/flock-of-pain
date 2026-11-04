"""Render docs/guide/*.md to HTML and PDF.

    uv run --with markdown docs/guide/build_pdf.py

Needs chromium on PATH. Images are referenced relative to docs/guide/.
"""
import re
import subprocess
import sys
from pathlib import Path

import markdown

HERE = Path(__file__).parent
CSS = """
body { font: 11pt/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1a1a1a; max-width: 52em; margin: 0 auto; padding: 0 1em; }
h1 { font-size: 22pt; margin-top: 0; border-bottom: 2px solid #1a1a1a; padding-bottom: .2em; }
h2 { font-size: 15pt; margin-top: 2em; border-bottom: 1px solid #bbb; padding-bottom: .15em; page-break-after: avoid; }
h3 { font-size: 12pt; margin-top: 1.4em; page-break-after: avoid; }
p, li { orphans: 3; widows: 3; }
img { max-width: 100%; display: block; margin: .8em auto; border: 1px solid #ccc; border-radius: 4px; page-break-inside: avoid; }
table { border-collapse: collapse; width: 100%; font-size: 9.5pt; margin: .8em 0; page-break-inside: avoid; }
th, td { border: 1px solid #ccc; padding: .35em .5em; vertical-align: top; text-align: left; }
th { background: #f0f0f0; }
code { font: 9.5pt ui-monospace, Menlo, Consolas, monospace; background: #f4f4f4; padding: 0 .25em; border-radius: 3px; }
hr { border: 0; border-top: 1px solid #ddd; margin: 2em 0; }
.subtitle { color: #555; margin-top: -1em; font-size: 12pt; }
@page { size: A4; margin: 18mm 16mm; }
"""


def build(md_path: Path) -> None:
    text = md_path.read_text(encoding="utf-8")
    meta = {}
    if text.startswith("---"):
        head, text = text.split("---", 2)[1:]
        for line in head.strip().splitlines():
            k, _, v = line.partition(":")
            meta[k.strip()] = v.strip().strip('"')
    body = markdown.markdown(text, extensions=["tables", "fenced_code", "toc"])
    # the first h1 is the title; put the subtitle right under it
    if meta.get("subtitle"):
        body = re.sub(r"(</h1>)", rf'\1<p class="subtitle">{meta["subtitle"]}</p>', body, count=1)
    lang = md_path.suffixes[0].lstrip(".") if len(md_path.suffixes) > 1 else "en"
    html = f'<!doctype html><html lang="{lang}"><head><meta charset="utf-8"><title>{meta.get("title", md_path.stem)}</title><style>{CSS}</style></head><body>{body}</body></html>'
    html_path = md_path.with_suffix(".html")
    html_path.write_text(html, encoding="utf-8")
    pdf_path = md_path.with_suffix(".pdf")
    subprocess.run(["chromium", "--headless", "--no-sandbox", "--disable-gpu", "--no-pdf-header-footer",
                    f"--print-to-pdf={pdf_path}", html_path.resolve().as_uri()], check=True, capture_output=True)
    html_path.unlink()
    print(f"{pdf_path.name}: {pdf_path.stat().st_size // 1024} KB")


if __name__ == "__main__":
    files = [Path(a) for a in sys.argv[1:]] or sorted(HERE.glob("user-guide.*.md"))
    for f in files:
        build(f)
