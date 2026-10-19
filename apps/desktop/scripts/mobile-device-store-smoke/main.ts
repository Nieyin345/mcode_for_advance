import { PairingManager } from "../../src/main/mobile/PairingManager.js";
import { SettingRepo, reset } from "../mobile-tunnel-host-smoke/stubs.js";
import { MOBILE_PAIRED_DEVICES_SETTING_KEY as KEY } from "@contracts/mobile";

let passed = 0, failed = 0;
function check(name: string, ok: boolean, details?: unknown): void {
  if (ok) { passed++; console.log("PASS " + name); }
  else { failed++; console.log("FAIL " + name + " " + JSON.stringify(details)); }
}
const manager = new PairingManager();
const token = "a".repeat(64);
const valid = { deviceId: "fictional-device", name: "Private QA phone", pairedAt: 1, lastSeenAt: Date.now(), deviceToken: token };

reset();
SettingRepo.set(KEY, JSON.stringify([valid]));
const authorized = await manager.validateToken(token);
check("valid device token still authenticates", authorized?.deviceId === valid.deviceId, authorized);
check("known device list excludes tokens", !(JSON.stringify(await manager.listDevices())).includes(token));

for (const raw of [
  "{",
  '{"devices":[]}',
  '[{"deviceId":"bad","deviceToken":42,"name":"x","pairedAt":1,"lastSeenAt":1}]',
  '[{"deviceId":"same","deviceToken":"a","name":"one","pairedAt":1,"lastSeenAt":1},{"deviceId":"same","deviceToken":"b","name":"two","pairedAt":1,"lastSeenAt":1}]',
]) {
  SettingRepo.set(KEY, raw);
  let issueRejected = false;
  try { manager.issueDevice("new QA device", "http://localhost:1234"); }
  catch { issueRejected = true; }
  check("★ issuing a new token must refuse to overwrite a corrupt list: " + raw.slice(0, 34),
    issueRejected && SettingRepo.get(KEY) === raw, { issueRejected, stored: SettingRepo.get(KEY)?.slice(0, 45) });

  let revokeRejected = false;
  try { await manager.revokeDevice("fictional-device"); }
  catch { revokeRejected = true; }
  check("★ revocation must not silently overwrite corrupt device records",
    revokeRejected && SettingRepo.get(KEY) === raw, { revokeRejected, stored: SettingRepo.get(KEY)?.slice(0, 45) });

  let listRejected = false;
  try { await manager.listDevices(); }
  catch { listRejected = true; }
  check("★ invalid paired-device table must be reported instead of masquerading as empty",
    listRejected, raw.slice(0, 30));
}
SettingRepo.set(KEY, JSON.stringify([{ ...valid, extraSecret: "EXTRA_PRIVATE_SENTINEL" }]));
const publiclyListed = await manager.listDevices();
check("★ listDevices must not expose arbitrary stored metadata to desktop/mobile",
  !JSON.stringify(publiclyListed).includes("EXTRA_PRIVATE_SENTINEL"), publiclyListed);
console.log(`mobile-device-store-smoke: ${passed}/${passed + failed}`);
if (failed) process.exitCode = 1;
