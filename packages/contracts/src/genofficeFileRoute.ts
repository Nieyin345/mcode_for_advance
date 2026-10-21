/**
 * GenOffice native-editor FILE ROUTING only; never use this as a path
 * authorization, resource-availability or OnlyOffice capability check.
 *
 * L2 pure adaptation of upstream GenOffice:
 *   genoffice/apps/shell/src/main/app-routing.ts (appForPath)
 *   upstream HEAD: aba076cc9b292461cc419288ee555e524f6250e1
 *   upstream license: Apache-2.0 (see genoffice/LICENSE)
 *
 * No runtime import from vendor: its shell/main module is not renderer-safe.
 * Keep the precedence and accepted suffixes paired with the upstream source;
 * genoffice-file-routing-smoke dynamically compares both implementations.
 */
export type GenofficeApp = "docs" | "sheets" | "slides" | "pdf" | "markdown" | "html";

const DOCX_RE = /\.(docx|odt|ott)$/i;
const XLSX_RE = /\.(xlsx|xlsm|xls|csv|tsv|ods|ots)$/i;
const PPTX_RE = /\.(pptx|odp|otp)$/i;
const PDF_RE = /\.pdf$/i;
const TEXT_RE = /\.(md|markdown|txt|json)$/i;
const HTML_RE = /\.html?$/i;

/** Which *vendor app* handles a file; undefined is deliberately not 'docs'. */
export function genofficeAppForPath(filePath: string): GenofficeApp | undefined {
  if (DOCX_RE.test(filePath)) return "docs";
  if (XLSX_RE.test(filePath)) return "sheets";
  if (PPTX_RE.test(filePath)) return "slides";
  if (PDF_RE.test(filePath)) return "pdf";
  if (TEXT_RE.test(filePath)) return "markdown";
  if (HTML_RE.test(filePath)) return "html";
  return undefined;
}
