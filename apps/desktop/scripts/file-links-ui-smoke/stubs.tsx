import { create } from "zustand";
export const audit = { searches: [] as string[], opened: [] as string[], mobile: [] as unknown[], files: [] as {name:string;path:string;relativePath:string}[] };
export function setFiles(paths: string[]) {
  audit.files = paths.map(relativePath => ({ name: relativePath.split("/").at(-1)!, path: `/workspace/${relativePath}`, relativePath }));
  audit.searches.length = 0; audit.opened.length = 0; audit.mobile.length = 0;
}
export const api = { file: { async search({query}:{query:string}) {
  audit.searches.push(query);
  return {files:audit.files.filter(f=>f.relativePath.includes(query))};
} } };
export const useSessionStore = create(() => ({
  projects:[{path:"/workspace"}], sessionsByProject:{}, pinnedSessions:[], streamSessions:[], worktreeInfoByRepo:{},
  openFileInIde(path:string) { audit.opened.push(path); },
  openMobileViewer(value:unknown) { audit.mobile.push(value); }, locale:"en",
}));
export let isElectron = true;
export function setDesktop(value:boolean) { isElectron=value; }
export const useI18n = () => ({t:(key:string)=>key,locale:"en"});
export const FileTypeIcon = () => <span aria-hidden="true">▧</span>;
