"""Builds the multi-worksheet fixture used by library-document-index-smoke.

Two worksheets (`Summary` active + `Detail`), each with a distinct token:

  - Summary: SUMMARY_ONLY_TOKEN (row 1)
  - Detail:  DETAIL_ONLY_TOKEN  (row 1)

The point of two sheets is that a reader which only opens the active worksheet
produces a document that *looks* complete while silently missing `Detail`.
Writing the OOXML by hand (rather than via openpyxl) keeps the fixture
dependency-free so the suite runs on any machine.
"""
import sys, pathlib, zipfile

root = pathlib.Path(sys.argv[1])
out = root / "multi-sheet.xlsx"

CT = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    '</Types>'
)
ROOT_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    '</Relationships>'
)
# activeTab 0 -> `Summary` is the active worksheet, which is exactly what a
# single-sheet reader reads when no --sheet is passed.
WORKBOOK = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    '<sheets>'
    '<sheet name="Summary" sheetId="1" r:id="rId1"/>'
    '<sheet name="Detail" sheetId="2" r:id="rId2"/>'
    '</sheets>'
    '</workbook>'
)
WB_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
    '</Relationships>'
)


def sheet(cell_text):
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>%s</t></is></c></row></sheetData>'
        '</worksheet>' % cell_text
    )


with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", CT)
    z.writestr("_rels/.rels", ROOT_RELS)
    z.writestr("xl/workbook.xml", WORKBOOK)
    z.writestr("xl/_rels/workbook.xml.rels", WB_RELS)
    z.writestr("xl/worksheets/sheet1.xml", sheet("SUMMARY_ONLY_TOKEN"))
    z.writestr("xl/worksheets/sheet2.xml", sheet("DETAIL_ONLY_TOKEN"))

print("wrote", out)
