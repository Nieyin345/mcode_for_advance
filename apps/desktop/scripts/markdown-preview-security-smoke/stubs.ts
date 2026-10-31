type LibraryItem = { mdPath?: string };

const items = new Map<string, LibraryItem>();
let root = "";

export function setRoot(value: string): void {
  root = value;
}

export function putItem(id: string, item: LibraryItem): void {
  items.set(id, item);
}

export const LibraryRepo = {
  get(id: string): LibraryItem | undefined {
    return items.get(id);
  },
};

export function libraryRoot(): string {
  if (!root) throw new Error("Smoke library root was not configured");
  return root;
}

/** Minimal fixture parser: this smoke verifies filesystem boundaries, not Markdown grammar. */
export function assetRefsOf(markdown: string): string[] {
  const refs = new Set<string>();
  for (const match of markdown.matchAll(/!\[[^\]]*\]\((?:<([^>]+)>|([^)]*))\)/g)) {
    const value = (match[1] ?? match[2] ?? "").trim().split(/\s+/, 1)[0] ?? "";
    if (value) refs.add(value);
  }
  for (const match of markdown.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (value) refs.add(value);
  }
  return [...refs];
}

export const log = { warn: (..._args: unknown[]): void => undefined };
