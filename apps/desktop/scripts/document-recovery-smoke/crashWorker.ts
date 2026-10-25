/**
 * Child-process crash injector for DOCX recovery smoke. Called only with
 * isolated temp paths supplied by its own test; never from product runtime.
 * The parent forcibly terminates this exact child after the new snapshot
 * payload is durable, but BEFORE manifest pointer publication.
 */
import { writeFileSync } from "node:fs";
import { writeDocRecovery } from "@main/document/documentRecovery.js";

const [filePath, dataRoot, baseRevision] = process.argv.slice(2);
if (!filePath || !dataRoot || !baseRevision) throw Error("missing isolated fixture arguments");
const next = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x73, 0x74, 0x75, 0x76]);
let alive: NodeJS.Timeout | null = null;
await writeDocRecovery({
  filePath, dataRoot, baseRevision, bytes: next,
  beforeManifestCommit: () => new Promise<void>(() => {
    // Deliberately stay alive *inside the original document file lease*.
    alive = setInterval(() => undefined, 2000);
    process.stdout.write("READY_TO_KILL\n");
  }),
});
if (alive) clearInterval(alive);
writeFileSync("impossible.txt", "The test must never reach here");
throw Error("Crash injector unexpectedly completed");
