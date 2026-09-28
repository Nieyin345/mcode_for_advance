import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { RelayVpsConfigSchema } from "@contracts/relay";
import { verifyRelayHostKey } from "@main/relay/hostKey.js";

const key = Buffer.from("synthetic SSH public host key fixture, no network");
const valid = "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
assert.equal(verifyRelayHostKey(key, valid), true);
assert.equal(verifyRelayHostKey(Buffer.from("attacker"), valid), false);
assert.equal(verifyRelayHostKey(key, ""), false);
assert.equal(verifyRelayHostKey(key, undefined), false);
const fields = { host: "fixture.invalid", sshPort: 22, username: "test", password: "", publicPort: 7331 };
assert.equal(RelayVpsConfigSchema.safeParse({ ...fields, hostKeyFingerprint: valid }).success, true);
assert.equal(RelayVpsConfigSchema.safeParse(fields).success, false);
assert.equal(RelayVpsConfigSchema.safeParse({ ...fields, hostKeyFingerprint: "not a fingerprint" }).success, false);
console.log("maint-p1-relay-smoke: 7/7 passed");
