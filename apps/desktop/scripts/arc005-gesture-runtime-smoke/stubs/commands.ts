export const performed: string[] = [];
export function collectCommands(_state: unknown) { return [
  "layout.toggle-left", "layout.toggle-right", "layout.toggle-bottom-terminal", "session.close", "session.new",
].map(id => ({ id, label: id, perform: () => { performed.push(id); } })); }
export function commandDisplayName(id: string): string { return id; }
