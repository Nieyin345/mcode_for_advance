"use strict";
const verify = require("../../build/verify-native-fs-after-pack.cjs");
(async () => {
  await verify({ appOutDir: process.argv[2] });
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
