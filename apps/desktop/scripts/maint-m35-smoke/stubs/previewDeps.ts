// Non-rendered dependencies of FilePreview; actual FilePreview + path helper remain real.
export const api = { library: {
  readFile: async () => { throw Error("No IPC permitted in the isolated render test"); },
  entryPath: async () => { throw Error("No IPC permitted in the isolated render test"); },
} };
export const useSessionStore = { getState: () => ({ quoteIntoComposer: () => {} }) };
export const useToastStore = { getState: () => ({ push: () => {} }) };
export function makeQuoteTag(_args: unknown) { return "quote"; }
export const ChunkedMarkdown = () => null;
export const SelectionToolbar = () => null;
export const SelectionQuoteMenu = () => null;
export const DocxPreview = () => null;
export const PptxPreview = () => null;
export const XlsxPreview = () => null;
export const PdfPreview = () => null;
// Office now renders through the OnlyOffice pane (7862578); like the other
// viewers it is a non-rendered leaf here — the test is about the PDF branch.
export const OnlyOfficeEditorPane = () => null;

export default function MarkdownPreviewPane() { throw new Error("Markdown renderer is outside this PDF-only test"); }
