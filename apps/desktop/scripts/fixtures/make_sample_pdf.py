"""生成冒烟用的样例 PDF —— `scripts/fixtures/sample-paper.pdf`。

只在需要重新生成时跑一次(**产物是提交进仓的**,冒烟脚本只是读它)。

为什么手工拼而不是用 reportlab / fpdf:仓里没有那两个包,而为了一个 1KB 的样例
去加一个依赖不划算。结构是能推出来的,而且生成完**必须真跑一遍 pdf.js 读它** ——
拼错的 PDF 看上去和"被测代码坏了"一模一样。

用法:python scripts/fixtures/make_sample_pdf.py
"""
import os
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "sample-paper.pdf")

# 正文。用英文 —— 标准 14 号字体不带中文字形,写中文会得到一片空白(而那看起来
# 像"抽取失败")。冒烟断言的是"抽出了文本",不是"抽出了什么文本"。
LINES = [
    "A Sample Paper for Headless Smoke Tests",
    "",
    "This file exists only so that the local pdf.js extraction path",
    "in library/convert.ts can be exercised without network access.",
    "It carries a real text layer, so extractPdfText returns text",
    "rather than the empty result that scanned documents produce.",
    "",
    "The assertions that read it only check that something was read",
    "and that the markdown landed on disk.",
]

# 内容流:每行一句 Tj,行距 16。
parts = ["BT", "/F1 12 Tf", "16 TL", "72 720 Td"]
for line in LINES:
    escaped = line.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
    parts.append(f"({escaped}) Tj")
    parts.append("T*")
parts.append("ET")
content = "\n".join(parts).encode("latin1")
compressed = zlib.compress(content)

objects = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
    b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    b"<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(compressed)
    + compressed
    + b"\nendstream",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    # Info 字典:pdfText 的元数据探针会读它,顺带覆盖那条路。
    b"<< /Title (A Sample Paper for Headless Smoke Tests) "
    b"/Author (Mcode Smoke Fixtures) >>",
]

body = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
offsets = []
for i, obj in enumerate(objects, start=1):
    offsets.append(len(body))
    body += b"%d 0 obj\n" % i + obj + b"\nendobj\n"

xref_at = len(body)
body += b"xref\n0 %d\n" % (len(objects) + 1)
body += b"0000000000 65535 f \n"
for off in offsets:
    body += b"%010d 00000 n \n" % off
body += b"trailer\n<< /Size %d /Root 1 0 R /Info 6 0 R >>\n" % (len(objects) + 1)
body += b"startxref\n%d\n%%%%EOF\n" % xref_at

with open(OUT, "wb") as f:
    f.write(bytes(body))
print("wrote %s (%d bytes)" % (OUT, len(body)))
