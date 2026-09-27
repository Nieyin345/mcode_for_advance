import { join, isAbsolute } from 'node:path';
const dir=process.env.P2_TEST_DIR;
if(!dir || !isAbsolute(dir))throw Error('Isolated P2_TEST_DIR required');
export function dataRoot():string {return join(dir!,'data');}
export function isKnownWorkspaceRoot(path:string):boolean {return path===join(dir!,'workspace');}
