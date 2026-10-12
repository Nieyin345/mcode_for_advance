import sys, pathlib, zipfile
from pptx import Presentation
from openpyxl import Workbook
root=pathlib.Path(sys.argv[1])
p=Presentation()
for i in range(2):
 slide=p.slides.add_slide(p.slide_layouts[5])
 slide.shapes.title.text="SLIDE_%d 研究😀 "%(i+1)+"Research text "*100
p.save(root/"slides.pptx")
w=Workbook();w.active.title="Research";w.active.append(["Title","Year"]);w.active.append(["研究论文😀",2026]);w.save(root/"table.xlsx")
# 【MC-065】一个**声明尺寸极大、真实数据极小**的工作簿:dimension 写 A1:ZZ1000000,
# 但 sheetData 只有 3 行真实数据。`ws[rg]` 会照 dimension/materialize 整个 702×1000000 矩形,
# 与 max_rows/max_cols 无关;新代码在迭代之前夹紧,只碰真实存在的那几行。
# 逐字节手写 zip,好精确控制 <dimension ref>。
def _wide():
 ct='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'
 rootr='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
 wbx='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Wide" sheetId="1" r:id="rId1"/></sheets></workbook>'
 rels='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
 rows=''.join('<row r="%d"><c r="A%d" t="inlineStr"><is><t>WIDE_%d</t></is></c><c r="B%d" t="inlineStr"><is><t>b%d</t></is></c></row>'%(i,i,i,i,i) for i in (1,2,3))
 sh='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:ZZ1000000"/><sheetData>%s</sheetData></worksheet>'%rows
 with zipfile.ZipFile(root/"wide.xlsx","w",zipfile.ZIP_DEFLATED) as z:
  z.writestr("[Content_Types].xml",ct);z.writestr("_rels/.rels",rootr)
  z.writestr("xl/workbook.xml",wbx);z.writestr("xl/_rels/workbook.xml.rels",rels)
  z.writestr("xl/worksheets/sheet1.xml",sh)
_wide()
xml='<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>'+('研究😀 文档正文 '*300)+'</w:t></w:r></w:p></w:body></w:document>'
with zipfile.ZipFile(root/"text.docx","w") as z:z.writestr("word/document.xml",xml)
# 【MC-065】一个抽取文本**远超子进程输出预算**的文档:读数前它会让子进程吐出约 20 MiB,
# 用来验证「子进程输出到界即提前终止并显式报错」,而不是「跑完再悄悄截断成一份假完整正文」。
big='A'*(20*1024*1024)
xmlb='<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>'+big+'</w:t></w:r></w:p></w:body></w:document>'
with zipfile.ZipFile(root/"huge.docx","w",zipfile.ZIP_DEFLATED) as z:z.writestr("word/document.xml",xmlb)

# ── 【MC-065】三个「输入资源预算」红例夹具 ───────────────────────────────────────────
def _ooxml_parts(sheet_name, dimension, sheet_data, compresslevel=6):
    ct='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'
    rootr='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
    wbx='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="%s" sheetId="1" r:id="rId1"/></sheets></workbook>'%sheet_name
    rels='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
    sh='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="%s"/><sheetData>%s</sheetData></worksheet>'%(dimension, sheet_data)
    return ct, rootr, wbx, rels, sh

# (1) 恶意大稀疏坐标:dimension 声明 A1:ZZ1000000,真实数据只有**相隔极远的两格**
#     (第 1 行与第 1000000 行)。夹紧到 max_rows/max_cols 之前若去 materialize 整个矩形,
#     就是十万亿格;而且 max_rows=1000×max_cols=200=200000 格**超过** maxCells(100000),
#     新模型必须显式回报「行×列被夹到 500×200」——不是默默假装读全。
_sparse_rows='<row r="1"><c r="A1" t="inlineStr"><is><t>SPARSE_TOP</t></is></c></row><row r="1000000"><c r="A1000000" t="inlineStr"><is><t>SPARSE_BOTTOM</t></is></c></row>'
_ct,_rootr,_wbx,_rels,_sh=_ooxml_parts("Sparse","A1:ZZ1000000",_sparse_rows)
with zipfile.ZipFile(root/"sparse.xlsx","w",zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml",_ct);z.writestr("_rels/.rels",_rootr)
    z.writestr("xl/workbook.xml",_wbx);z.writestr("xl/_rels/workbook.xml.rels",_rels)
    z.writestr("xl/worksheets/sheet1.xml",_sh)

# (2) 公式/文本膨胀:一个小工作簿,但其单元格文本总量**超过子进程输出预算**(16 MiB)——
#     行×列都不大(在 max_rows/max_cols 之内),危险来自「单元格文本体积」而非格数。
#     20 列 × 300 行 × 8 KiB 文本 ≈ 49 MB;默认 max_rows=200 时读出的 200×20×8KiB ≈ 32 MB
#     也稳稳超过 16 MiB 子进程输出预算,故单元格文本膨胀会被子进程字节预算拦下。
_fat_cols=20;_fat_rows=300;_fat_cell='T'*8192
_fat_rows_xml=[]
for r in range(1,_fat_rows+1):
    cells="".join('<c r="%s%d" t="inlineStr"><is><t>%s</t></is></c>'%(chr(64+c),r,_fat_cell) for c in range(1,_fat_cols+1))
    _fat_rows_xml.append('<row r="%d">%s</row>'%(r,cells))
_ct2,_rootr2,_wbx2,_rels2,_sh2=_ooxml_parts("Fat","A1:T%d"%_fat_rows,"".join(_fat_rows_xml))
with zipfile.ZipFile(root/"fat.xlsx","w",zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml",_ct2);z.writestr("_rels/.rels",_rootr2)
    z.writestr("xl/workbook.xml",_wbx2);z.writestr("xl/_rels/workbook.xml.rels",_rels2)
    z.writestr("xl/worksheets/sheet1.xml",_sh2)

# (3) 高压缩(deflate 炸弹):一个 ~200 KB 的 .docx 容器,其 word/document.xml 声明解压后
#     体积 ≥ 200 MiB(比例 1000:1)。DOCX 抽取会 `z.read('word/document.xml')` **整份**解压,
#     故这里是「交给解析器之前必须前拒」的最尖锐向量。文件本体很小,不占磁盘。
_bomb_target=200*1024*1024
_head='<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>'
_tail='</w:t></w:r></w:p></w:body></w:document>'
_pad=_bomb_target-len(_head)-len(_tail)
_block='Z'*65536
with zipfile.ZipFile(root/"bomb.docx","w",zipfile.ZIP_DEFLATED,compresslevel=9) as z:
    with z.open("word/document.xml","w") as f:
        f.write(_head.encode())
        left=_pad
        while left>0:
            n=min(left,len(_block));f.write(_block[:n].encode());left-=n
        f.write(_tail.encode())

# (4) **最干净的判别式**:一个 .xlsx 里,真正要读的那张表极小(openpyxl 能正常读出
#     `SMALL_OK`),但另挂一个**声明解压 200 MiB 的无用成员**(xl/media/big.bin)。抽取器
#     根本不会读它 —— 故「能拦下它」只可能来自**交给解析器之前**那层压缩膨胀前置预算;
#     撤掉前置预算,这个工作簿会**顺利返回 SMALL_OK**(不是被子进程字节兜底报错),
#     所以断言能精确区分「前拒生效」与「碰巧被别的预算兜住」。
_bl_ct='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="bin" ContentType="application/octet-stream"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'
_bl_rootr='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
_bl_wbx='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Small" sheetId="1" r:id="rId1"/></sheets></workbook>'
_bl_rels='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
_bl_sh='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:A1"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>SMALL_OK</t></is></c></row></sheetData></worksheet>'
with zipfile.ZipFile(root/"bloated.xlsx","w",zipfile.ZIP_DEFLATED,compresslevel=9) as z:
    z.writestr("[Content_Types].xml",_bl_ct);z.writestr("_rels/.rels",_bl_rootr)
    z.writestr("xl/workbook.xml",_bl_wbx);z.writestr("xl/_rels/workbook.xml.rels",_bl_rels)
    z.writestr("xl/worksheets/sheet1.xml",_bl_sh)
    with z.open("xl/media/big.bin","w") as f:
        left=200*1024*1024  # 200 MiB 的无用成员,抽取器不会读
        _zblock=b'\x00'*65536
        while left>0:
            n=min(left,len(_zblock));f.write(_zblock[:n]);left-=n
print("Generated isolated PPTX/XLSX/DOCX fixtures")
