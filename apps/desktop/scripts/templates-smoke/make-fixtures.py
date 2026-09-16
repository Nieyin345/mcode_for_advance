#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""重造 templates-smoke 的三个夹具。

    python scripts/templates-smoke/make-fixtures.py

为什么要有一个**真的生成脚本**:夹具是真 OOXML 包(不是随手拼的字节),而"怎么拼
出来的"以前只写在 `main.ts` 末尾的注释里 —— 要改夹具就得照着注释再手写一遍 Python,
写歪了还看不出来(包能解开、但某个部件缺失,症状是"渲染出来少一半")。放在这儿,
重造是一条命令的事。

三个包**必须都是真的**,各走各的那条路:

  minimal.docx  → `kind: "docx"`,交给 docx-preview 排版
  minimal.xlsx  → `kind: "xlsx"`,交给 @js-preview/excel 排版
  minimal.pptx  → `kind: "pptx"`,交给 pptx-preview 排版

⚠️ 每个包里那个"主部件"不能省(`word/document.xml` / `xl/workbook.xml` /
`ppt/presentation.xml`)。冒烟套件现在只验"字节对不对路"、读不出这个,所以省了它**这
一轮也不会红** —— 但那就不是一份能开的 Office 文件了,而夹具的价值恰恰在于"它就是用户
会拖进来的那种东西"。哪天要拿它去核对渲染,少了主部件就是当场排不出来。

> 要**更像真模版**的那种稿子(母版 / 版式 / 主题 / 图片 / 图表),用 `make-deck.py`
> 那份 —— 它要 python-pptx,所以不进 `run.sh`。

依赖只有标准库。
"""
import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fixtures")

XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def write(name, parts):
    """把 {部件路径: 文本} 打成一个包。ZIP_DEFLATED 与真 Office 一致。"""
    path = os.path.join(OUT, name)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for part, text in parts.items():
            z.writestr(part, text)
    print("wrote %-14s %6d bytes" % (name, os.path.getsize(path)))


def content_types(overrides):
    rows = "\n".join(
        '  <Override PartName="/%s" ContentType="%s"/>' % (p, ct) for p, ct in overrides
    )
    return (
        XML_HEAD
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
        '  <Default Extension="rels" '
        'ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'
        '  <Default Extension="xml" ContentType="application/xml"/>\n'
        + rows
        + "\n</Types>\n"
    )


def rels(target, rel_type):
    return (
        XML_HEAD
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
        '  <Relationship Id="rId1" Type="%s/%s" Target="%s"/>\n' % (NS_REL, rel_type, target)
        + "</Relationships>\n"
    )


# ────────────────────────────── Word ──────────────────────────────

write(
    "minimal.docx",
    {
        "[Content_Types].xml": content_types(
            [
                (
                    "word/document.xml",
                    "application/vnd.openxmlformats-officedocument."
                    "wordprocessingml.document.main+xml",
                )
            ]
        ),
        "_rels/.rels": rels("word/document.xml", "officeDocument"),
        # 一个 Heading1 + 一句话 + 页面设置。**不写 `styles.xml`** —— docx-preview
        # 缺它也能排(标题会退回默认字号),而夹具越小越好看清它到底读了什么。
        "word/document.xml": (
            XML_HEAD
            + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">\n'
            "  <w:body>\n"
            "    <w:p>\n"
            '      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>\n'
            "      <w:r><w:t>冒烟用的标题</w:t></w:r>\n"
            "    </w:p>\n"
            "    <w:p>\n"
            "      <w:r><w:t>这一行用来验证 Word 真的被渲染了。</w:t></w:r>\n"
            "    </w:p>\n"
            "    <w:sectPr>\n"
            '      <w:pgSz w:w="11906" w:h="16838"/>\n'
            '      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>\n'
            "    </w:sectPr>\n"
            "  </w:body>\n"
            "</w:document>\n"
        ),
        "word/_rels/document.xml.rels": (
            XML_HEAD
            + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>\n'
        ),
    },
)


# ───────────────────────────── Excel ─────────────────────────────

write(
    "minimal.xlsx",
    {
        "[Content_Types].xml": content_types(
            [
                (
                    "xl/workbook.xml",
                    "application/vnd.openxmlformats-officedocument."
                    "spreadsheetml.sheet.main+xml",
                ),
                (
                    "xl/worksheets/sheet1.xml",
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
                ),
                (
                    "xl/sharedStrings.xml",
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml",
                ),
                # 内联样式表。**不是**可省的装饰:x-data-spreadsheet 靠它决定数字要不要
                # 按百分比 / 两位小数画,缺了整份表会画成一片默认样式(仍然能开,只是
                # 看不出版式)—— 那正好是这个预览唯一要说的事,所以留着。
                (
                    "xl/styles.xml",
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml",
                ),
            ]
        ),
        "_rels/.rels": rels("xl/workbook.xml", "officeDocument"),
        "xl/workbook.xml": (
            XML_HEAD
            + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"\n'
            '          xmlns:r="%s">\n' % NS_REL
            + '  <sheets><sheet name="冒烟" sheetId="1" r:id="rId1"/></sheets>\n'
            + "</workbook>\n"
        ),
        "xl/_rels/workbook.xml.rels": (
            XML_HEAD
            + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
            '  <Relationship Id="rId1" Type="%s/worksheet" Target="worksheets/sheet1.xml"/>\n' % NS_REL
            + '  <Relationship Id="rId2" Type="%s/sharedStrings" Target="sharedStrings.xml"/>\n' % NS_REL
            + '  <Relationship Id="rId3" Type="%s/styles" Target="styles.xml"/>\n' % NS_REL
            + "</Relationships>\n"
        ),
        # 表头用共享字符串(真 Excel 就是这么存的),数字用内联值。
        "xl/sharedStrings.xml": (
            XML_HEAD
            + '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">\n'
            "  <si><t>项目</t></si>\n"
            "  <si><t>数值</t></si>\n"
            "  <si><t>甲乙</t></si>\n"
            "  <si><t>丙丁</t></si>\n"
            "</sst>\n"
        ),
        "xl/worksheets/sheet1.xml": (
            XML_HEAD
            + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">\n'
            '  <sheetData>\n'
            '    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>\n'
            '    <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>12.5</v></c></row>\n'
            '    <row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>47</v></c></row>\n'
            "  </sheetData>\n"
            "</worksheet>\n"
        ),
        "xl/styles.xml": (
            XML_HEAD
            + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">\n'
            '  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>\n'
            '  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>\n'
            '  <borders count="1"><border/></borders>\n'
            '  <cellStyleXfs count="1"><xf/></cellStyleXfs>\n'
            '  <cellXfs count="1"><xf xfId="0"/></cellXfs>\n'
            "</styleSheet>\n"
        ),
    },
)


# ───────────────────────────── PowerPoint ─────────────────────────────

write(
    "minimal.pptx",
    {
        "[Content_Types].xml": content_types(
            [
                (
                    "ppt/presentation.xml",
                    "application/vnd.openxmlformats-officedocument."
                    "presentationml.presentation.main+xml",
                ),
                (
                    "ppt/slides/slide1.xml",
                    "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
                ),
            ]
        ),
        "_rels/.rels": rels("ppt/presentation.xml", "officeDocument"),
        "ppt/presentation.xml": (
            XML_HEAD
            + '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">\n'
            '  <p:sldIdLst><p:sldId id="256" r:id="rId2" xmlns:r="%s"/></p:sldIdLst>\n' % NS_REL
            + "</p:presentation>\n"
        ),
        # 抽文字那条路要能从这一行里读出下面那个 `<a:t>`(见 main.ts 的断言)。
        "ppt/slides/slide1.xml": (
            XML_HEAD
            + '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"\n'
            '       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">\n'
            "  <p:cSld>\n"
            "    <p:spTree>\n"
            "      <p:sp>\n"
            "        <p:txBody>\n"
            "          <a:p><a:r><a:t>抽出来的这一行</a:t></a:r></a:p>\n"
            "        </p:txBody>\n"
            "      </p:sp>\n"
            "    </p:spTree>\n"
            "  </p:cSld>\n"
            "</p:sld>\n"
        ),
    },
)
