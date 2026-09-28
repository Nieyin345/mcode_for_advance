import { resolve } from 'node:path';
export function dataRoot(): string {
  const root = process.env.MCODE_SMOKE_DATA_ROOT;
  if (!root || !process.env.MEMORY_INJECTION_ARTIFACTS || !resolve(root).startsWith(resolve(process.env.MEMORY_INJECTION_ARTIFACTS))) throw Error('An isolated memory test root is mandatory');
  return root;
}
