/** Fast isolated E1 / mutation runner for T79 Node-RED editor resources. */
import { checkPaletteResources } from "./paletteChecks.js";
let pass = 0;
let fail = 0;
checkPaletteResources((name, valid, details) => {
  if (valid) pass++;
  else { fail++; console.error("FAIL " + name, details ?? ""); }
});
console.log("T79 palette " + pass + "/" + (pass + fail));
if (fail) process.exitCode = 1;
