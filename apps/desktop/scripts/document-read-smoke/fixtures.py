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
print("Generated isolated PPTX/XLSX/DOCX fixtures")
