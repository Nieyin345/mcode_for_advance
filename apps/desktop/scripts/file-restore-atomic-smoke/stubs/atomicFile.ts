/** Deterministic atomic failure: production restoreFiles stays real. */
import { atomicReplaceFile as realAtomicReplaceFile } from "../../../src/main/lib/atomicFile.js";
export async function atomicReplaceFile(filePath:string,content:string|Uint8Array):Promise<void>{
 if(process.env.MCODE_TEST_ATOMIC_FAIL==="1") throw new Error("fixture: simulated atomic rename / fsync failure");
 return realAtomicReplaceFile(filePath,content);
}
