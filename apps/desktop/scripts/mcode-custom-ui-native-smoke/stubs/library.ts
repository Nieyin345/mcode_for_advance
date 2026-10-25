export let engine = "node-red";
export const setEngine = (value: string) => { engine = value; };
export function getWorkflow(id: string) {
  return { id, engine, nodes: [], edges: [], builtin: false };
}
