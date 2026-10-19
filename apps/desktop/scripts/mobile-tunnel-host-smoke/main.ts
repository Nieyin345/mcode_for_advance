import { SettingRepo, reset } from "./stubs.js";
import {
  MOBILE_TUNNEL_MODE_SETTING_KEY as MODE,
  MOBILE_TUNNEL_HOSTNAME_SETTING_KEY as HOST,
} from "@contracts/mobile";
import { mobileTunnelStatus, setMobileTunnelConfig } from "../../src/main/mobile/mobileTunnel.js";

let checks = 0;
let fails = 0;
function check(label: string, pass: boolean, detail?: unknown): void {
  checks++;
  if (!pass) { fails++; console.log("FAIL " + label + " " + JSON.stringify(detail)); }
  else console.log("PASS " + label);
}
const fetched: string[] = [];
globalThis.fetch = (async (uri: string | URL | Request) => {
  fetched.push(String(uri));
  return { status: 200, text: async () => '{"ok":true}' } as Response;
}) as typeof fetch;
reset();
SettingRepo.set(MODE, "external");
SettingRepo.set(HOST, "initial.example.com");
const old = SettingRepo.get(HOST);
for (const attack of [
  "guest@127.0.0.1",
  "127.0.0.1",
  "localhost",
  "evil.example.com:444",
  "https://trusted.example.com@127.0.0.1/api/health",
  "[::1]",
  "foo.example.com?redirect=@localhost",
  "foo.example.com#fragment",
]) {
  let rejected = false;
  try {
    await setMobileTunnelConfig({ mode: "external", hostname: attack });
  } catch { rejected = true; }
  check("★ malformed/non-public hostname is rejected before any settings writes: " + attack,
    rejected && SettingRepo.get(HOST) === old,
    { rejected, actual: SettingRepo.get(HOST) });
}
check("★ all invalid hostname candidates cause no outbound probe",
  fetched.length === 0, fetched);
const good = await setMobileTunnelConfig({
  mode: "external", hostname: "https://M.Example.com/phone",
});
check("known good HTTPS domain accepted and normalized",
  good.hostname === "m.example.com" && SettingRepo.get(HOST) === "m.example.com", good);
check("outbound probe only uses validated target origin",
  fetched.every((x) => x === "https://m.example.com/api/health"), fetched);
const fetches = fetched.length;
SettingRepo.set(HOST, "user@127.0.0.1");
const status = await mobileTunnelStatus();
check("★ malformed hostname already persisted must fail closed on status/probe",
  status.hostname === "" && fetched.length === fetches, { status, fetched });
console.log(`mobile-tunnel-host-smoke: ${checks - fails}/${checks}`);
if (fails) process.exitCode = 1;
