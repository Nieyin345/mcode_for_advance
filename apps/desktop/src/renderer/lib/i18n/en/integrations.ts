/** English mirror of `zh/integrations.ts`. Every key must be present or typecheck fails. */
export const en = {
  "settings.nav.integrations": "Integrations",
  "settings.integrations.title": "Integrations",
  "settings.integrations.desc":
    "Connect third-party paper services. A key is entered here once, encrypted by the main process with the OS credential store (the same mechanism as custom models), and stored locally; the UI only ever shows a masked form.",
  "settings.integrations.servicesTitle": "Connected services",
  "settings.integrations.getKey": "Get a key from the vendor",
  "settings.integrations.configured": "Configured",
  "settings.integrations.keyPlaceholder": "Paste the API key",
  "settings.integrations.keyPlaceholderSet": "Saved {masked} — paste again to replace",
  "settings.integrations.save": "Save",
  "settings.integrations.saved": "Saved",
  "settings.integrations.clear": "Clear",
  "settings.integrations.test": "Test connection",
  "settings.integrations.testing": "Testing…",

  "settings.integrations.mineru.name": "MinerU",
  "settings.integrations.mineru.desc":
    "Converts PDFs to Markdown. Imported papers are converted automatically, and the AI reads that Markdown when you add a library to the conversation — layout, formulas and tables are preserved.",

  // Batch conversion check (lives here because it's about whether MinerU actually works)
  "settings.integrations.statsTitle": "Conversion status",
  "settings.integrations.statsDesc":
    "How many papers in the library have been converted to Markdown. Without a conversion the AI can't read the text and full-text search can't find it.",
  "settings.integrations.statsTotal": "{n} papers total",
  "settings.integrations.statsConverted": "{n} converted",
  "settings.integrations.statsPending": "{n} pending",
  "settings.integrations.statsEmpty": "The library is empty",
  "settings.integrations.convertPending": "Convert {n} pending",
  "settings.integrations.convertAll": "Re-convert all",
  "settings.integrations.convertAllConfirm":
    "Re-convert every paper in the library? This re-uploads the PDFs and spends MinerU quota ({n} papers). Use “Convert pending” to only fill the gaps.",
  "settings.integrations.convertRunning": "Converting…",
  "settings.integrations.convertDone": "{n} converted",
  "settings.integrations.convertFailed": "{n} failed",
  "settings.integrations.convertNonePending": "Nothing pending",
  "settings.integrations.convertOne": "Re-convert",
  "settings.integrations.reasonNoMd": "Not converted to Markdown yet",
  "settings.integrations.reasonNoAssets": "{n} images missing from disk",
} as const;
