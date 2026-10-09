/** LibraryPicker 的 store 桩：可被 selector 调用，并暴露 getState。 */
type Sel = (s: Record<string, unknown>) => unknown;
let state: Record<string, unknown> = {};
export function __setState(next: Partial<Record<string, unknown>>): void {
  state = { ...state, ...next };
}
__setState({ collections: [], loadCollections: () => Promise.resolve() });

export const useLibraryStore = ((selector?: Sel) =>
  selector ? selector(state) : state) as unknown as ((selector?: Sel) => unknown) & {
  getState: () => Record<string, unknown>;
};
useLibraryStore.getState = () => state;
