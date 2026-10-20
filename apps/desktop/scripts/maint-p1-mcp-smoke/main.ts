import { strict as assert } from "node:assert";
import { maskMcpConfig, mergeMcpSecretEdits } from "@main/lib/mcpSecretEdit.js";
const stdio = { type: "stdio" as const, command: "node", env: { TOKEN: "TOP_SECRET", EMPTY: "" } };
const masked = maskMcpConfig(stdio);
assert.equal(JSON.stringify(masked).includes("TOP_SECRET"), false);
assert.deepEqual(masked.env, { TOKEN: "", EMPTY: "" });
assert.deepEqual(mergeMcpSecretEdits(stdio, masked), stdio);
assert.deepEqual(mergeMcpSecretEdits(stdio, { ...masked, env: { TOKEN: "REPLACED" } }).env, { TOKEN: "REPLACED" });
assert.deepEqual(mergeMcpSecretEdits(stdio, { ...masked, env: {} }).env, {});
const remote = { type: "http" as const, url: "https://example.invalid/mcp", headers: { Authorization: "Bearer SECRET" } };
assert.equal(JSON.stringify(maskMcpConfig(remote)).includes("Bearer SECRET"), false);
assert.deepEqual(mergeMcpSecretEdits(remote, maskMcpConfig(remote)), remote);
// Older/imported server records may carry both env and headers, regardless
// of the active transport discriminant. A shallow spread must never leak
// the unused secret container into the renderer's config editing form.
const importedRemote = {
  ...remote, env: { LEGACY_CREDENTIAL: "legacy-remote-environment-secret" },
};
const maskedImportedRemote = maskMcpConfig(importedRemote as any);
assert.equal(JSON.stringify(maskedImportedRemote).includes("legacy-remote-environment-secret"), false,
  "HTTP masked editing view must not leak unused env fields");
const importedStdio = {
  ...stdio, headers: { Authorization: "Bearer stale-http-credential" },
};
assert.equal(JSON.stringify(maskMcpConfig(importedStdio as any)).includes("stale-http-credential"), false,
  "stdio masked editing view must not leak unused HTTP headers");
// A stdio MCP server can keep the same executable while changing the script
// in args/cwd. Such a new endpoint must never inherit blank masked secrets.
const oldScript = { ...stdio, args: ["old-server.mjs"], cwd: "C:/safe-old" };
const hidden = maskMcpConfig(oldScript);
assert.throws(() => mergeMcpSecretEdits(oldScript, { ...hidden, args: ["untrusted.mjs"] }), /密钥|命令|参数|重新填写/i);
assert.throws(() => mergeMcpSecretEdits(oldScript, { ...hidden, cwd: "C:/different" }), /密钥|命令|参数|重新填写/i);
// Re-entering a value deliberately is permitted on a changed invocation.
assert.equal((mergeMcpSecretEdits(oldScript, { ...hidden, args: ["untrusted.mjs"], env: { TOKEN: "new-secret", EMPTY: "new-value" } }) as typeof stdio).env.TOKEN, "new-secret");
// Existing values are only from OWN keys, never Object.prototype.constructor.
const unusual = Object.fromEntries([["constructor", ""], ["__proto__", ""]]);
const oddMerged = mergeMcpSecretEdits(stdio, { ...masked, env: unusual });
assert.equal(oddMerged.env?.["constructor"], "");
assert.equal((oddMerged.env as Record<string, string> | undefined)?.["__proto__"], "");
assert.equal(Object.hasOwn(oddMerged.env ?? {}, "constructor"), true);
// An existing own special-name credential still retains the real old value.
const specialOld = { ...stdio, env: JSON.parse('{"constructor":"own-token"}') as Record<string, string> };
const specialMasked = maskMcpConfig(specialOld);
assert.equal(mergeMcpSecretEdits(specialOld, specialMasked).env?.["constructor"], "own-token");
console.log("maint-p1-mcp-smoke: credential isolation assertions passed");
