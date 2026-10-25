"""Read-only Microsoft PowerPoint staging matrix for native Slides operations."""
from pathlib import Path
import argparse,json
import win32com.client

a=argparse.ArgumentParser()
a.add_argument("--evidence",required=True)
args=a.parse_args()
root=Path(args.evidence).resolve(strict=True)
assert ".tmp" in root.parts and "electron-u1" in root.parts and root.name=="slides-ms-office-interop-isolation"
files=sorted(root.glob("stage-*.pptx"))
if len(files)!=7:raise SystemExit("Expected exactly seven saved stage files; found "+str(len(files)))
app=None
report={}
try:
    app=win32com.client.DispatchEx("PowerPoint.Application")
    app.DisplayAlerts=1
    for file in files:
        pres=None
        try:
            pres=app.Presentations.Open(str(file),ReadOnly=-1,Untitled=0,WithWindow=0)
            slide=pres.Slides(1)
            note_text=[]
            notes=slide.NotesPage
            for i in range(1,notes.Shapes.Count+1):
                shape=notes.Shapes(i)
                try:
                    if shape.HasTextFrame and shape.TextFrame.HasText:
                        note_text.append(str(shape.TextFrame.TextRange.Text))
                except Exception:
                    continue
            combined_notes=" ".join(note_text)
            charts=[]
            for i in range(1,slide.Shapes.Count+1):
                try:
                    shape=slide.Shapes(i)
                    if shape.HasChart:
                        charts.append(int(shape.Chart.SeriesCollection().Count))
                except Exception:
                    continue
            animation_count=int(slide.TimeLine.MainSequence.Count)
            needs_notes=file.name!="stage-0-baseline.pptx"
            ok=(not needs_notes or "Interop stage notes" in combined_notes)
            report[file.name]={"ok":ok,"slides":int(pres.Slides.Count),
                "bytes":file.stat().st_size,"notes_preserved":"Interop stage notes" in combined_notes,
                "chart_series_counts":charts,"animation_count":animation_count}
        except Exception as e:
            report[file.name]={"ok":False,"error":str(e),"bytes":file.stat().st_size}
        finally:
            if pres is not None:pres.Close()
finally:
    if app is not None:app.Quit()
print(json.dumps(report,ensure_ascii=False,indent=2))
raise SystemExit(0 if all(x["ok"] for x in report.values()) else 1)
