import type { LibraryCollection, LibraryItem } from "@contracts/library";

/** Render-only rows. The trusted Mcode library.list IPC remains the search authority. */
export interface PickerRow {
  key: string;
  header?: string;
  item?: LibraryItem;
  collection?: LibraryCollection;
  errorCollectionId?: string;
}

/** Selecting across queries must not depend on the currently visible page. */
export function selectedLibraryPickerEntries(
  selected: ReadonlySet<string>,
  labels: ReadonlyMap<string, string>,
): Array<{ key: string; name: string }> {
  return [...selected].flatMap((key) => {
    const name = labels.get(key);
    return name === undefined ? [] : [{ key, name }];
  });
}

export function buildLibraryPickerRows({
  collections, itemsOf, expanded, query, searchItems, loadingLabel, errorLabel,
}: {
  collections: readonly LibraryCollection[];
  itemsOf: Readonly<Record<string, readonly LibraryItem[] | "loading" | "error">>;
  expanded: ReadonlySet<string>;
  query: string;
  searchItems: readonly LibraryItem[];
  loadingLabel: string;
  errorLabel: string;
}): PickerRow[] {
  const q = query.trim().toLocaleLowerCase();
  const out: PickerRow[] = [];
  const seenItems = new Set<string>();

  if (q) {
    // Classification and item searches are separate domains: a matching
    // document does not need its parent collection's title to match.
    for (const c of collections) {
      if (c.name.toLocaleLowerCase().includes(q)) out.push({ key: `c:${c.id}`, collection: c });
    }
    // library.list({query}) already covers ALL collections, even unopened ones.
    for (const item of searchItems) {
      if (seenItems.has(item.id)) continue;
      seenItems.add(item.id);
      out.push({ key: `i:${item.id}`, item });
    }
    return out;
  }

  for (const c of collections) {
    out.push({ key: `c:${c.id}`, collection: c });
    if (!expanded.has(c.id)) continue;
    const entries = itemsOf[c.id];
    if (entries === "loading") {
      out.push({ key: `l:${c.id}`, header: loadingLabel });
    } else if (entries === "error") {
      out.push({ key: `e:${c.id}`, header: errorLabel, errorCollectionId: c.id });
    } else if (entries) {
      for (const item of entries) {
        // One item can occur under multiple collections. Its attachment key
        // is unique (i:id); never draw duplicate React keys or controls.
        if (seenItems.has(item.id)) continue;
        seenItems.add(item.id);
        out.push({ key: `i:${item.id}`, item });
      }
    }
  }
  return out;
}
