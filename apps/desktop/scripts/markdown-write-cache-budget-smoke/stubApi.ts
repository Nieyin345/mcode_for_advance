const files=new Map<string,string>();
export const writes:Array<{path:string,content:string}>=[];
export function setDisk(path:string,text:string){files.set(path,text);}
export function getDisk(path:string){return files.get(path)??"";}
export const api={file:{
async readFile({filePath}:{filePath:string}){return {content:getDisk(filePath),version:"fixture-version"};},
async writeFile({filePath,content}:{filePath:string;content:string}){files.set(filePath,content);writes.push({path:filePath,content});return {ok:true};},
}};
