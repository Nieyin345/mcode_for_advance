export interface SyntheticNodeInput {
  tagName?: string;
  attributes?: Record<string, string>;
  text?: string;
  visible?: boolean;
  children?: SyntheticNodeInput[];
}

function splitOutsideSyntax(selector: string, delimiter: "," | " "): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let bracketDepth = 0;
  for (const char of selector) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "[") bracketDepth++;
    if (char === "]") bracketDepth--;
    const isDelimiter = delimiter === ","
      ? char === "," && bracketDepth === 0
      : /\s/.test(char) && bracketDepth === 0;
    if (isDelimiter) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function splitSelectors(selector: string): string[] {
  return splitOutsideSyntax(selector, ",");
}

function matchesSimple(element: SyntheticElement, selector: string): boolean {
  const tag = selector.match(/^[A-Za-z][A-Za-z0-9-]*/)?.[0];
  if (tag && element.tagName.toLowerCase() !== tag.toLowerCase()) return false;

  const withoutAttrs = selector.replace(/\[[^\]]+\]/g, "");
  for (const className of withoutAttrs.matchAll(/\.([A-Za-z0-9_-]+)/g)) {
    const classes = (element.getAttribute("class") ?? "").split(/\s+/);
    if (!classes.includes(className[1])) return false;
  }

  const attrs = selector.match(/\[[^\]]+\]/g) ?? [];
  for (const token of attrs) {
    const body = token.slice(1, -1).trim();
    const match = body.match(/^([^\s=*]+)\s*(\*=|=)?\s*(?:"([^"]*)"|'([^']*)')?$/);
    if (!match) return false;
    const [, name, operator] = match;
    const expected = match[3] ?? match[4] ?? "";
    const actual = element.getAttribute(name);
    if (operator === "=" && actual !== expected) return false;
    if (operator === "*=" && !(actual ?? "").includes(expected)) return false;
    if (!operator && actual === null) return false;
  }
  return true;
}

function matchesSelectorChain(element: SyntheticElement, selector: string): boolean {
  const parts = splitOutsideSyntax(selector, " ");
  if (parts.length === 0 || !matchesSimple(element, parts[parts.length - 1])) return false;
  let ancestor = element.parentElement;
  for (let index = parts.length - 2; index >= 0; index--) {
    while (ancestor && !matchesSimple(ancestor, parts[index])) ancestor = ancestor.parentElement;
    if (!ancestor) return false;
    ancestor = ancestor.parentElement;
  }
  return true;
}

export class SyntheticElement {
  readonly tagName: string;
  readonly attributes: Record<string, string>;
  readonly children: SyntheticElement[];
  readonly visible: boolean;
  readonly ownText: string;
  parentElement: SyntheticElement | null = null;

  constructor(input: SyntheticNodeInput = {}) {
    this.tagName = input.tagName ?? "div";
    this.attributes = { ...(input.attributes ?? {}) };
    this.children = (input.children ?? []).map((child) => new SyntheticElement(child));
    this.visible = input.visible ?? true;
    this.ownText = input.text ?? "";
    for (const child of this.children) child.parentElement = this;
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  getAttribute(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  getClientRects(): Array<{ width: number }> {
    return this.visible ? [{ width: 100 }] : [];
  }

  getBoundingClientRect(): { x: number; y: number; width: number; height: number } {
    return { x: 0, y: 0, width: this.visible ? 100 : 0, height: this.visible ? 24 : 0 };
  }

  matches(selector: string): boolean {
    return splitSelectors(selector).some((part) => matchesSelectorChain(this, part));
  }

  closest(selector: string): SyntheticElement | null {
    let current: SyntheticElement | null = this;
    while (current) {
      if (current.matches(selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  contains(candidate: SyntheticElement | null | undefined): boolean {
    let current = candidate ?? null;
    while (current) {
      if (current === this) return true;
      current = current.parentElement;
    }
    return false;
  }

  querySelectorAll(selector: string): SyntheticElement[] {
    const selectors = splitSelectors(selector);
    const found: SyntheticElement[] = [];
    const visit = (parent: SyntheticElement) => {
      for (const child of parent.children) {
        if (selectors.some((part) => matchesSelectorChain(child, part))) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  querySelector(selector: string): SyntheticElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

export class SyntheticDocument {
  readonly body: SyntheticElement;

  constructor(children: SyntheticNodeInput[] = []) {
    this.body = new SyntheticElement({ tagName: "body", children });
  }

  querySelectorAll(selector: string): SyntheticElement[] {
    if (splitSelectors(selector).includes("body")) return [this.body, ...this.body.querySelectorAll(selector.replace(/\bbody\b/g, "body"))];
    return this.body.querySelectorAll(selector);
  }

  querySelector(selector: string): SyntheticElement | null {
    if (splitSelectors(selector).some((part) => part.trim() === "body")) return this.body;
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

export function el(
  tagName: string,
  attributes: Record<string, string> = {},
  text = "",
  children: SyntheticNodeInput[] = [],
): SyntheticNodeInput {
  return { tagName, attributes, text, children };
}

export function workspaceMain(children: SyntheticNodeInput[] = []): SyntheticNodeInput {
  return el("main", { "data-testid": "workspace-main" }, "", children);
}

export function fixturePanel(kind: string, children: SyntheticNodeInput[] = []): SyntheticNodeInput {
  return el("section", {
    "data-testid": "arc005-fixture-panel",
    "data-arc-fixture": kind,
  }, "", children);
}

export function toolRow(): SyntheticNodeInput {
  return el("button", {
    class: "flex w-full items-center gap-2 rounded-[var(--radius-control)] py-1.5 text-left hover:bg-surface-muted/50",
  }, "Read demo.ts");
}
