#!/usr/bin/env python3
"""Read-only compatibility check for Mcode's REAL Electron-U1 Office outputs.

Inputs MUST be generated under this repository's isolated
apps/desktop/.tmp/electron-u1-build-*/run/.../project/ and are NEVER written.
Checks independent openpyxl/python-pptx and (optionally) isolated Microsoft
Office COM instances. No Save/SaveAs calls, no user-document mutation.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import traceback
import zipfile
from xml.etree import ElementTree as ET


def check_temp_fixture(path: pathlib.Path, kind: str) -> pathlib.Path:
    p = path.resolve(strict=True)
    parts = [s.lower() for s in p.parts]
    is_built_fixture = any(x.startswith("electron-u1-build-") for x in parts)
    is_u1_evidence = ("electron-u1" in parts and
                      "slides-ms-office-interop-isolation" in parts and
                      p.name.startswith("stage-"))
    if ".tmp" not in parts or not (is_built_fixture or is_u1_evidence):
        raise ValueError(f"{kind}: refused non-U1 test artifact: {p}")
    if p.suffix.lower() != {"word": ".docx", "excel": ".xlsx", "powerpoint": ".pptx"}[kind]:
        raise ValueError(f"{kind}: wrong file type: {p}")
    return p


def independent_read(word: pathlib.Path, excel: pathlib.Path, deck: pathlib.Path) -> dict:
    import openpyxl
    from pptx import Presentation

    w = openpyxl.load_workbook(excel, read_only=False, data_only=False, keep_links=False)
    try:
        ws = w.worksheets[0]
        observed = [ws["A1"].value, ws["B1"].value, ws["C1"].value]
        excel_ok = observed == [5, 7, "=SUM(A1:B1)"]
    finally:
        w.close()

    p = Presentation(deck)
    slide = p.slides[0]
    charts = []
    for shape in slide.shapes:
        try:
            if shape.has_chart:
                chart = shape.chart
                charts.append({
                    "categories": [str(c.label) for c in chart.plots[0].categories],
                    "series": [[v for v in s.values] for s in chart.series],
                })
        except Exception as exc:
            charts.append({"error": str(exc)})
    deck_ok = len(p.slides) >= 1 and any(
        "2026" in c.get("categories", []) and any(9 in s for s in c.get("series", []))
        for c in charts
    )

    with zipfile.ZipFile(word, "r") as z:
        node = ET.fromstring(z.read("word/document.xml"))
        txt = "".join(e.text or "" for e in node.iter() if e.tag.endswith("}t"))
        word_ok = "-MCODE-NATIVE-TOOL" in txt

    return {
        "independent": {
            "word": {"ok": word_ok, "contains_model_edit": word_ok},
            "excel": {"ok": excel_ok, "values_and_formula": observed},
            "powerpoint": {"ok": deck_ok, "slides": len(p.slides), "charts": charts},
        }
    }


def office_com_read(word: pathlib.Path, excel: pathlib.Path, deck: pathlib.Path) -> dict:
    # DispatchEx creates a NEW isolated COM automation instance, never
    # hijacks a user's existing Office window/instance.
    import win32com.client
    outcome: dict = {}

    word_app = None
    doc = None
    try:
        word_app = win32com.client.DispatchEx("Word.Application")
        word_app.Visible = False
        word_app.DisplayAlerts = 0
        word_app.AutomationSecurity = 3  # Disable macros
        doc = word_app.Documents.Open(str(word), ReadOnly=True, AddToRecentFiles=False, Visible=False)
        content = str(doc.Content.Text)
        outcome["word"] = {"ok": "-MCODE-NATIVE-TOOL" in content,
                           "contains_model_edit": "-MCODE-NATIVE-TOOL" in content}
    finally:
        if doc is not None:
            doc.Close(False)
        if word_app is not None:
            word_app.Quit(False)

    excel_app = None
    book = None
    try:
        excel_app = win32com.client.DispatchEx("Excel.Application")
        excel_app.Visible = False
        excel_app.DisplayAlerts = False
        excel_app.AutomationSecurity = 3
        book = excel_app.Workbooks.Open(str(excel), UpdateLinks=0, ReadOnly=True,
                                        IgnoreReadOnlyRecommended=True, AddToMru=False)
        s = book.Worksheets(1)
        values = [s.Range("A1").Value, s.Range("B1").Value, s.Range("C1").Formula]
        outcome["excel"] = {"ok": values == [5, 7, "=SUM(A1:B1)"],
                            "values_and_formula": values}
    finally:
        if book is not None:
            book.Close(False)
        if excel_app is not None:
            excel_app.Quit()

    ppt_app = None
    pres = None
    try:
        ppt_app = win32com.client.DispatchEx("PowerPoint.Application")
        ppt_app.DisplayAlerts = 1  # ppAlertsNone (avoid repair prompts)
        pres = ppt_app.Presentations.Open(str(deck), ReadOnly=-1, Untitled=0, WithWindow=0)
        slide = pres.Slides(1)
        found = []
        for i in range(1, slide.Shapes.Count + 1):
            s = slide.Shapes(i)
            if s.HasChart:
                ch = s.Chart
                found.append({"has_chart": True, "series_count": int(ch.SeriesCollection().Count)})
        outcome["powerpoint"] = {"ok": int(pres.Slides.Count) >= 1 and bool(found),
                                 "slides": int(pres.Slides.Count), "charts": found}
    finally:
        if pres is not None:
            pres.Close()
        if ppt_app is not None:
            ppt_app.Quit()

    return {"microsoft_office_readonly": outcome}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--word", required=True)
    parser.add_argument("--excel", required=True)
    parser.add_argument("--powerpoint", required=True)
    parser.add_argument("--with-office", action="store_true")
    args = parser.parse_args()
    word = check_temp_fixture(pathlib.Path(args.word), "word")
    excel = check_temp_fixture(pathlib.Path(args.excel), "excel")
    deck = check_temp_fixture(pathlib.Path(args.powerpoint), "powerpoint")
    report = independent_read(word, excel, deck)
    if args.with_office:
        report.update(office_com_read(word, excel, deck))
    print(json.dumps(report, ensure_ascii=False, indent=2, default=str))
    return 0 if all(d.get("ok") is True for group in report.values() for d in group.values()) else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        traceback.print_exc()
        sys.exit(2)
