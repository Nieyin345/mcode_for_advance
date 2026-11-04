"use strict";
/** Probe one packaged N-API addon in a dedicated process.
 * Windows locks loaded DLLs until process exit; never load inside builder.
 */
const fs = require("node:fs");
const os = require("node:os");

(async () => {
  const binary = process.argv[2];
  if (!binary) throw new Error("missing packaged addon argument");
  const addon = require(binary);
  if (!addon || typeof addon.openRoot !== "function" ||
      !Number.isSafeInteger(addon.napiVersion) || addon.napiVersion < 8) {
    throw new Error("packaged addon is missing the N-API 8 openRoot contract");
  }
  const pinned = addon.openRoot(fs.realpathSync(os.tmpdir()));
  try {
    const stat = await pinned.stat([]);
    if (stat.type !== "directory") throw new Error("packaged addon did not open a directory root");
  } finally {
    pinned.close();
  }
  console.log("NATIVE_FS_PROBE_OK");
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
