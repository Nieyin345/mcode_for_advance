/** English mirror of `zh/templates.ts`. Every key must be present or typecheck fails. */
export const en = {
  "settings.nav.templates": "Templates",
  "settings.templates.title": "Templates",
  "settings.templates.desc":
    "Keep reusable templates: slides, LaTeX paper classes, Word, code, and image templates that pair a set of images with one code file. Each entry is a folder — you can also drop files into it straight from your file manager and they show up here.",

  "settings.templates.kind.ppt": "Slides",
  "settings.templates.kind.latex": "LaTeX",
  "settings.templates.kind.word": "Word",
  "settings.templates.kind.code": "Code",
  "settings.templates.kind.image": "Images",

  "settings.templates.newName": "New template: give it a name first",
  "settings.templates.nameRequired": "Give the template a name first — it becomes the folder name.",
  "settings.templates.pickFiles": "Choose files…",
  "settings.templates.pickFolder": "Choose folder…",
  "settings.templates.empty": "No templates in this category yet",
  "settings.templates.fileCount": "{n} files",
  "settings.templates.imagePair": "{img} images · {code} code files",
  "settings.templates.reveal": "Open folder",
  "settings.templates.openFailed": "Could not open",
  "settings.templates.delete": "Delete template",
  // Deleting only moves it to the recycle bin (reversible); the irreversible step lives
  // in the bin itself, see templates.ctx.purgeConfirm
  "settings.templates.deleteConfirm":
    "Move “{name}” to the recycle bin? Its files move with it. You can restore it later, or delete it for good from the bin.",

  "templates.chat.addToContext": "Add a template to context",
  "templates.chat.searchPlaceholder": "Search templates (name or category: latex, slides…)",
  "templates.chat.addN": "Add {n}",
  "templates.chat.alreadyAdded": "Already in context",
  "templates.chat.empty": "No templates yet",
  "templates.chat.emptyHint":
    "Add them under Settings → Data location → Templates, or drop files straight into the templates folder.",
  "templates.chat.noMatch": "No matching template",
  "templates.chat.loadFailed": "Could not read the template list",

  "templates.section.title": "Templates",
  "templates.section.new": "New template",
  "templates.section.namePlaceholder": "Template name (becomes the folder name)",
  "templates.section.loadFailed": "Could not read the template list",
  "templates.section.moreFiles": "{n} more files not listed",
  "templates.section.all": "All {kind} templates",
  "templates.section.trash": "Recycle bin",
  "templates.section.trashEmpty": "The recycle bin is empty",
  "templates.ctx.attachToChat": "Add to current chat",
  "templates.ctx.rename": "Rename",
  "templates.ctx.restore": "Restore",
  "templates.ctx.purge": "Delete permanently",
  "templates.ctx.purgeConfirm":
    "Permanently delete “{name}”? The folder is removed from disk along with everything in it, and this cannot be undone.",
  "templates.ctx.actionFailed": "That didn't work",
  "templates.ctx.openExternal": "Open in external app",
  "templates.ctx.preview": "Preview in app",

  "templates.preview.title": "Template file",
  "templates.preview.empty": "Click a file under Templates in the left bar to see it here",
  "templates.preview.rendering": "Laying out…",
  "templates.preview.docxFailed":
    "This Word document couldn't be laid out in the app (it may be encrypted, or use a format we don't support yet). Use “Open in external app” to see it as it is.",
  "templates.preview.xlsxFailed":
    "This spreadsheet couldn't be laid out in the app (it may be encrypted, or use features we don't support yet). Use “Open in external app” to see it as it is.",
  "templates.preview.pptxFailed":
    "This presentation couldn't be laid out in the app (it may be encrypted, or use drawing features we haven't implemented yet). Use “Open in external app” to see it as it is.",
  "templates.preview.truncated":
    "This file is large — only the beginning is shown ({size} total). Use “Open in external app” for all of it.",
  "templates.preview.binary":
    "This file can't be previewed in the app (it isn't text or a directly viewable image). Use “Open in external app”.",
  "templates.preview.tooLarge":
    "This file is too large to preview ({size}). Use “Open in external app”.",
  "templates.preview.actionFailed": "That didn't work",
  "templates.preview.emptyFile": "(this file is empty)",
} as const;
