/** English mirror of `zh/templates.ts`. Every key must be present or typecheck fails. */
export const en = {
  "settings.templates.kind.ppt": "Slides",
  "settings.templates.kind.latex": "LaTeX",
  "settings.templates.kind.word": "Word",
  "settings.templates.kind.code": "Code",
  "settings.templates.kind.image": "Images",

  "templates.section.all": "All {kind} templates",

  "templates.ctx.openExternal": "Open in external app",
  "templates.preview.rendering": "Laying out…",
  "templates.preview.docxFailed":
    "This Word document couldn't be laid out in the app (it may be encrypted, or use a format we don't support yet). Use “Open in external app” to see it as it is.",
  "templates.preview.xlsxFailed":
    "This spreadsheet couldn't be laid out in the app (it may be encrypted, or use features we don't support yet). Use “Open in external app” to see it as it is.",
  "templates.preview.pptxFailed":
    "This presentation couldn't be laid out in the app (it may be encrypted, or use drawing features we haven't implemented yet). Use “Open in external app” to see it as it is.",
  "templates.preview.emptyFile": "(this file is empty)",
} as const;
