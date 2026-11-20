"""Builds docs/writeup.docx from docs/writeup.md (python-docx). Export to PDF with Word afterwards."""
import re
import sys
from pathlib import Path

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor, Cm

SRC = Path(__file__).with_name("writeup.md")
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("writeup.docx")
FONT = "Calibri"
ACCENT = RGBColor(0x1F, 0x3A, 0x5F)
INLINE = re.compile(r"(\*\*[^*]+\*\*|`[^`]+`)")


def add_inline(par, text, size=10):
    for part in INLINE.split(text):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**"):
            run = par.add_run(part[2:-2]); run.bold = True
        elif part.startswith("`") and part.endswith("`"):
            run = par.add_run(part[1:-1]); run.font.name = "Consolas"; run.font.size = Pt(size - 1)
            continue
        else:
            run = par.add_run(part)
        run.font.size = Pt(size)


def tight(par, before=0, after=2):
    par.paragraph_format.space_before = Pt(before)
    par.paragraph_format.space_after = Pt(after)
    par.paragraph_format.line_spacing = 1.05


def shade(cell, hex_fill):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear"); shd.set(qn("w:color"), "auto"); shd.set(qn("w:fill"), hex_fill)
    tc_pr.append(shd)


def build():
    doc = Document()
    sec = doc.sections[0]
    sec.left_margin = sec.right_margin = Cm(1.8)
    sec.top_margin = sec.bottom_margin = Cm(1.5)
    normal = doc.styles["Normal"]
    normal.font.name = FONT; normal.font.size = Pt(10)
    normal.element.rPr.rFonts.set(qn("w:eastAsia"), FONT)

    lines = SRC.read_text(encoding="utf-8").splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("# "):
            p = doc.add_paragraph(); tight(p, 0, 6)
            r = p.add_run(line[2:]); r.bold = True; r.font.size = Pt(17); r.font.color.rgb = ACCENT
        elif line.startswith("## "):
            p = doc.add_paragraph(); tight(p, 8, 3)
            r = p.add_run(line[3:]); r.bold = True; r.font.size = Pt(12); r.font.color.rgb = ACCENT
            p.paragraph_format.keep_with_next = True
        elif line.startswith("| "):
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                cells = [c.strip() for c in lines[i].strip("|").split("|")]
                if not all(re.fullmatch(r"-+", c) for c in cells):
                    rows.append(cells)
                i += 1
            table = doc.add_table(rows=len(rows), cols=len(rows[0]))
            table.style = "Table Grid"; table.alignment = WD_TABLE_ALIGNMENT.CENTER
            widths = [Cm(4.2), Cm(1.6), Cm(11.6)]
            for ri, row in enumerate(rows):
                for ci, val in enumerate(row):
                    cell = table.cell(ri, ci); cell.width = widths[ci] if ci < len(widths) else Cm(3)
                    cell.paragraphs[0].text = ""
                    add_inline(cell.paragraphs[0], val, 9)
                    tight(cell.paragraphs[0], 0, 0)
                    if ri == 0:
                        shade(cell, "DCE6F0")
                        for run in cell.paragraphs[0].runs: run.bold = True
            continue
        elif re.match(r"^\s*- ", line):
            level = (len(line) - len(line.lstrip())) // 2
            p = doc.add_paragraph(style="List Bullet 2" if level else "List Bullet"); tight(p, 0, 1)
            add_inline(p, line.strip()[2:])
        elif re.match(r"^\s*\d+\. ", line):
            level = (len(line) - len(line.lstrip())) // 3
            p = doc.add_paragraph(style="List Number 2" if level else "List Number"); tight(p, 0, 1)
            add_inline(p, re.sub(r"^\s*\d+\.\s", "", line))
        elif line.strip():
            p = doc.add_paragraph(); tight(p, 0, 3)
            add_inline(p, line.strip())
        i += 1
    doc.save(OUT)
    print(OUT)


if __name__ == "__main__":
    build()
