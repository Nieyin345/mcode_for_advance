"use strict";
/**
 * T11: GenOffice exact-version license integration and carrier policy.
 *
 * The reviewed source manifest may now verify a license text through one of two
 * exact carriers (see `GENOFFICE_LICENSE_SOURCE_KINDS` in
 * `stage-genoffice-resources.cjs`):
 *   1. a standalone file at a pinned raw.githubusercontent.com revision, or
 *   2. the complete license section embedded in the README of the exact
 *      SRI-verified npm release tarball (byte range + README hash recorded).
 *
 * This suite pins the *integration result* and the *policy's teeth*:
 *  - the six README-carried texts (fastdom, hash.js, isarray, ot-json1,
 *    strictdom, unicount) are verified and byte-equal (modulo whitespace) to the
 *    T9 evidence committed under docs/research/genoffice-license/evidence/;
 *  - the four packages T9 could not resolve stay blocked with no material and no
 *    source record, and the strict gate still fails closed naming exactly them;
 *  - a text missing an operative element (retention notice) is rejected even
 *    when its hash matches — the ot-text-unicode failure mode;
 *  - malformed README-carrier records (wrong URL, broken byte range, unsigned
 *    weaker chain, unknown kind) are rejected;
 *  - tampering with a recorded text or hash turns the gate red, and restoration
 *    is byte-exact.
 *
 * All mutations happen on fixture copies in an OS temp directory. The reviewed
 * manifest, materials and the real GenOffice vendor tree are never modified.
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../../../..");
const stage = require("../../build/stage-genoffice-resources.cjs");
const manifestPath = path.join(root, "apps/desktop/build/vendor-licenses/genoffice/manifest.json");
const licenseRoot = path.join(path.dirname(manifestPath), "licenses");
const evidenceRoot = path.join(root, "docs/research/genoffice-license/evidence");
const README_CARRIED = Object.freeze(["fastdom", "hash.js", "isarray", "ot-json1", "strictdom", "unicount"]);
const STILL_BLOCKED = Object.freeze([
  "@electron-internal/extract-zip", "lazy-val", "ot-text-unicode", "react-remove-scroll-bar",
]);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-t11-license-carrier-"));
let total = 0;

function pass(label) {
  total++;
  console.log("  PASS " + label);
}
function rejects(label, fn, pattern) {
  assert.throws(fn, pattern);
  pass(label);
}
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const norm = (text) => text.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
function readManifest() {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}
/** Fixture = manifest copy + only the materials a "verified" copy needs. The
 *  manifest hash changes, so callers pass the fixture's own hash explicitly. */
function copyFixture(name) {
  const dir = path.join(temp, name);
  const licenses = path.join(dir, "licenses");
  fs.mkdirSync(licenses, { recursive: true });
  const manifest = path.join(dir, "manifest.json");
  fs.copyFileSync(manifestPath, manifest);
  const source = readManifest();
  for (const item of source.items.filter(entry => entry.status === "verified")) {
    fs.copyFileSync(path.join(licenseRoot, item.licenseFile), path.join(licenses, item.licenseFile));
  }
  return { dir, licenses, manifest, source };
}
function validateFixture(fixture, requireComplete = false) {
  return stage.validateGenofficeLicenseManifest({
    manifestPath: fixture.manifest, licenseRoot: fixture.licenses,
    expectedManifestSha256: sha256(fs.readFileSync(fixture.manifest)), requireComplete,
  });
}
function saveAndWrite(fixture, mutate) {
  const saved = fs.readFileSync(fixture.manifest);
  const object = JSON.parse(saved.toString("utf8"));
  mutate(object);
  fs.writeFileSync(fixture.manifest, JSON.stringify(object, null, 2) + "\n");
  return () => {
    fs.writeFileSync(fixture.manifest, saved);
    assert.equal(sha256(fs.readFileSync(fixture.manifest)), sha256(saved));
  };
}
function item(object, name) {
  const found = object.items.find(entry => entry.name === name);
  assert.ok(found, "fixture manifest item " + name);
  return found;
}

try {
  console.log("T11 GenOffice license carrier smoke");
  const real = readManifest();

  // ---- Integration result -------------------------------------------------
  const validation = stage.validateGenofficeLicenseManifest({
    manifestPath, licenseRoot, vendorRoot: path.join(root, "genoffice"), repoRoot: root,
    requireComplete: false,
  });
  pass("real reviewed manifest validates against the pinned inventory and its SHA-256 pin");
  assert.equal(validation.verifiedCount, 14);
  // 【T117】四个上游缺文本的包现在走「逐条签字的例外」，不再进 blockedPackages。
  // 断言改成同时钉住**两边**：blocked 必须是 0（没有未签字的），excused 必须是那四个。
  // 如果哪天有人把 disposition 删了，`blockedPackages` 会变回 4，这条立刻红。
  assert.equal(validation.blockedCount, 0);
  assert.equal(validation.excusedCount, 4);
  assert.deepEqual(validation.excusedPackages.map(entry => entry.name).sort(), [...STILL_BLOCKED].sort());
  assert.equal(real.expectedPackageCount, 18);
  assert.equal(real.resolvedCount, 14);
  assert.equal(real.blockedCount, 4);
  assert.equal(real.excusedCount, 4);
  // `releaseEligible` 的语义在 T117 之后是「没有**未签字**的阻塞」——
  // 四个 blocked 全部逐个签了 disposition，所以它是 true。而 `resolvedCount`
  // 仍是 14：那四个包**没有**完整原文，这个事实不能被例外抹掉。
  assert.equal(real.releaseEligible, true);
  pass("manifest summary is 14 verified / 4 excused / 0 unexcused; releaseEligible true via signed exceptions");

  assert.equal(stage.GENOFFICE_LICENSE_MANIFEST_SHA256, sha256(fs.readFileSync(manifestPath)));
  pass("gate's pinned manifest SHA-256 equals the reviewed manifest bytes");

  for (const name of README_CARRIED) {
    const entry = item(real, name);
    assert.equal(entry.status, "verified", name + " must be verified");
    assert.equal(entry.licenseSourceKind, "exact-npm-release-readme-section");
    assert.equal(entry.licenseSourceUrl, entry.npmTarballUrl);
    const range = entry.licenseSourceByteRange;
    const material = fs.readFileSync(path.join(licenseRoot, entry.licenseFile));
    assert.equal(material.length, range.length);
    assert.equal(range.end, range.start + range.length);
    // Fixed boundary convention: section runs from the first non-whitespace
    // byte after the License heading to EOF, so end must be the README length.
    assert.equal(range.end, entry.licenseSourceReadmeBytes);
    assert.notEqual(material[0], 0x23, name + " material must not start with a '#' heading");
    assert.equal(entry.licenseTextSha256, sha256(material));
    assert.equal(entry.licenseSourceByteRangeSha256, sha256(material));
    assert.ok(/^#{1,4}[ \t]*licen[cs]e[ \t]*$/i.test(entry.licenseSourceReadmeHeading));
    const proof = entry.licenseSourceVerification;
    assert.equal(proof.readmeSha256, entry.licenseSourceReadmeSha256);
    assert.ok(["exact-commit-readme-equal", "public-commit-readme-equal-weaker-chain"].includes(proof.kind));
    if (proof.kind === "public-commit-readme-equal-weaker-chain") {
      assert.equal(proof.publishedGitHeadRetrievable, false);
      assert.ok(proof.reviewSignoff.length >= 40);
    }
    pass(name + " README-carrier record is complete (range, README hash, proof, material hash)");
  }

  const evidenceFiles = {
    fastdom: "fastdom-1.0.12-LICENSE.txt",
    "hash.js": "hash.js-1.1.7-LICENSE.txt",
    isarray: "isarray-1.0.0-LICENSE.txt",
    "ot-json1": "ot-json1-1.0.2-LICENSE.txt",
    strictdom: "strictdom-1.0.1-LICENSE.txt",
    unicount: "unicount-1.1.0-LICENSE.txt",
  };
  for (const name of README_CARRIED) {
    const entry = item(real, name);
    const material = fs.readFileSync(path.join(licenseRoot, entry.licenseFile), "utf8");
    const evidence = fs.readFileSync(path.join(evidenceRoot, evidenceFiles[name]), "utf8");
    // The committed T9 evidence file still carries the heading line; the
    // material is the same section body under the fixed boundary convention.
    const evidenceBody = evidence.replace(/^#{1,4}[ \t]*licen[cs]e[ \t]*\r?\n/i, "");
    assert.equal(norm(material), norm(evidenceBody), name + " material differs from committed T9 evidence");
    pass(name + " material is byte-equal (modulo line endings/heading) to its committed T9 evidence");
  }

  for (const name of STILL_BLOCKED) {
    const entry = item(real, name);
    assert.equal(entry.status, "blocked");
    assert.equal(entry.licenseSourceUrl, null);
    assert.equal(entry.licenseFile, null);
    assert.equal(entry.licenseTextSha256, null);
    assert.ok(entry.missingEvidence.length > 80);
    pass(name + " stays blocked with no material or source record");
  }
  const blockedWithMaterials = fs.readdirSync(licenseRoot)
    .filter(file => STILL_BLOCKED.some(name => file.startsWith(name.replace(/^@/, "") + "-") || file.startsWith(name.split("/").pop() + "-")));
  assert.deepEqual(blockedWithMaterials, []);
  pass("no license material exists on disk for any of the four blocked packages (no borrowed text)");

  const extractZip = item(real, "@electron-internal/extract-zip");
  assert.match(extractZip.missingEvidence, /MUST NOT be borrowed/);
  assert.match(extractZip.missingEvidence, /MIT/);
  assert.match(extractZip.missingEvidence, /BSD-2-Clause/);
  const scrollBar = item(real, "react-remove-scroll-bar");
  assert.match(scrollBar.missingEvidence, /MUST NOT be backfilled/);
  pass("blocked evidence names the newer-release trap for extract-zip and react-remove-scroll-bar");

  // 【T117】这两条要验的性质是「**没有签字**的阻塞仍然 fail-closed」。
  //
  // 从前它们直接拿真实清单跑 —— 那时四个包都没 disposition，所以顺带就验了。
  // 现在真实清单给四个包都签了字，**继续拿它跑就验不到东西了**（会通过而不是拒绝）。
  //
  // 改法：把真实清单**复制一份、删掉四个 disposition**，用它跑。
  // 这样验的还是「没签字 → 拒绝」，而且用的是真实的 missingEvidence 文本。
  //
  // 光删 disposition 还不够 —— 清单自己的 summary 必须先自洽（excusedCount、
  // releaseEligible 会跟着变），否则红在「summary 与实际条目不符」上，
  // **根本不是本节要验的「未签字即拒绝」**。（第二版就栽在这。）
  const unsignedManifest = JSON.parse(JSON.stringify(real));
  for (const entry of unsignedManifest.items) delete entry.missingEvidenceDisposition;
  unsignedManifest.excusedCount = 0;
  unsignedManifest.releaseEligible = false;
  // 注意：这份副本**必须落在 repoRoot 里** —— `validateGenofficeLicenseManifest`
  // 会对 manifestFile 做 assertNativeVendorPath(repoRoot, …)，写到 `root/..`
  // 会被「路径越界」拒掉，而那条红跟本节要验的「未签字即拒绝」毫无关系。
  // （我第一版就是写到 `root/..`，结果 208 行红在一个完全不相关的原因上。）
  const unsignedDir = path.join(__dirname, "../../.tmp");
  fs.mkdirSync(unsignedDir, { recursive: true });
  const unsignedPath = path.join(unsignedDir, `unsigned-manifest-${process.pid}.json`);
  const unsignedBytes = Buffer.from(JSON.stringify(unsignedManifest, null, 2) + "\n", "utf8");
  fs.writeFileSync(unsignedPath, unsignedBytes);
  const unsignedSha = crypto.createHash("sha256").update(unsignedBytes).digest("hex");
  // 下面两条都用这份未签字副本，清理放在最后一条之后（见本节末尾的 finally）。
  rejects("strict release gate still fails closed naming the four unresolved packages", () => {
    stage.validateGenofficeLicenseManifest({
      manifestPath: unsignedPath, licenseRoot, vendorRoot: path.join(root, "genoffice"), repoRoot: root,
      requireComplete: true, expectedManifestSha256: unsignedSha,
    });
  }, /@electron-internal\/extract-zip@1\.0\.5 .*lazy-val@1\.0\.5 .*ot-text-unicode@4\.0\.0 .*react-remove-scroll-bar@2\.3\.8/s);
  // 第三条：**未签字的条目不许生成完整通知** —— 原来这条用的是真实 `validation`，
  // 而它现在 `blockedCount` 是 0（全签了），所以要把 validation 换成「未签字」那版。
  rejects("complete third-party notice cannot be generated while four packages are unresolved", () => {
    const unsignedValidation = stage.validateGenofficeLicenseManifest({
      manifestPath: unsignedPath, licenseRoot, vendorRoot: path.join(root, "genoffice"), repoRoot: root,
      requireComplete: false, expectedManifestSha256: unsignedSha,
    });
    stage.buildCompleteThirdPartyNotice(
      fs.readFileSync(path.join(root, "genoffice/apps/shell/build/THIRD-PARTY-NOTICES.txt"), "utf8"),
      unsignedValidation,
    );
  }, /unresolved/i);
  // 未签字的清单在通知一节还要再验一次，清理留到那里之后（见本节末尾）。

  // ---- Negative control: a license text missing the retention clause -------
  // Same shape as ot-text-unicode 4.0.0: copyright + grant + disclaimer, but no
  // "The above copyright notice ... shall be included" sentence. It must be
  // rejected on elements, not accepted because its hash matches.
  const retentionless = [
    "Copyright 2011 Fixture Contributors",
    "",
    "Permission is hereby granted, free of charge, to any person obtaining a copy",
    'of this software and associated documentation files (the "Software"), to deal',
    "in the Software without restriction, including without limitation the rights",
    "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
    "copies of the Software, and to permit persons to whom the Software is",
    "furnished to do so, subject to the following condition:",
    "",
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
    "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
    "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
    "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
    "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN",
    "THE SOFTWARE.",
    "",
  ].join("\n");
  assert.deepEqual(stage.missingLicenseElements("MIT", retentionless), ["retention notice"]);
  assert.deepEqual(stage.missingLicenseElements("ISC", retentionless),
    ["grant", "retention notice", "warranty disclaimer"]);
  pass("element check: retentionless MIT-shaped text fails only on the retention notice");

  const retentionFixture = copyFixture("retentionless");
  const fastdomEntry = item(retentionFixture.source, "fastdom");
  const retentionBytes = Buffer.from(retentionless, "utf8");
  fs.writeFileSync(path.join(retentionFixture.licenses, fastdomEntry.licenseFile), retentionBytes);
  const restoreRetention = saveAndWrite(retentionFixture, (object) => {
    const entry = item(object, "fastdom");
    entry.licenseTextSha256 = sha256(retentionBytes);
    entry.licenseSourceByteRangeSha256 = sha256(retentionBytes);
    entry.licenseSourceByteRange = { start: 0, end: retentionBytes.length, length: retentionBytes.length };
    entry.licenseSourceReadmeBytes = retentionBytes.length;
  });
  rejects("a self-consistent but retentionless MIT text is rejected on license elements", () =>
    validateFixture(retentionFixture), /missing MIT element\(s\) retention notice/);
  restoreRetention();
  fs.writeFileSync(path.join(retentionFixture.licenses, fastdomEntry.licenseFile),
    fs.readFileSync(path.join(licenseRoot, fastdomEntry.licenseFile)));
  pass("retentionless fixture removed; original fastdom material restored");

  // ---- Negative controls: malformed README-carrier records -----------------
  const carrierCases = [
    ["README carrier pointing at a web page instead of the exact tarball", (entry) => {
      entry.licenseSourceUrl = "https://github.com/wilsonpage/fastdom/blob/master/README.md";
    }, /not the exact npm tarball/],
    ["README carrier with an inconsistent byte range", (entry) => {
      entry.licenseSourceByteRange = { ...entry.licenseSourceByteRange, end: entry.licenseSourceByteRange.end + 1 };
    }, /byte range is missing or inconsistent/],
    ["README carrier whose range hash differs from the license text hash", (entry) => {
      entry.licenseSourceByteRangeSha256 = "0".repeat(64);
    }, /range hash differs/],
    ["README carrier without a README byte-equality proof", (entry) => {
      delete entry.licenseSourceVerification;
    }, /lacks a README byte-equality proof/],
    ["weaker-chain proof without reviewer signoff", (entry) => {
      entry.licenseSourceVerification = {
        kind: "public-commit-readme-equal-weaker-chain",
        commit: "1e5915b0e720e40f744b3901f6f7be5df71e3441",
        commitClass: "public-upstream-master-ancestor",
        publishedGitHeadRetrievable: false,
        readmeSha256: entry.licenseSourceReadmeSha256,
        reviewSignoff: "",
      };
    }, /weaker README proof lacks commit\/class\/signoff/],
    ["unknown licenseSourceKind is rejected", (entry) => {
      entry.licenseSourceKind = "exact-npm-release-readme";
    }, /inadmissible source carrier \(unknown licenseSourceKind\)/],
    ["standalone-file carrier must still come from raw.githubusercontent.com", (entry) => {
      entry.licenseSourceKind = "exact-upstream-source-file";
      entry.licenseSourceUrl = "https://example.com/LICENSE";
    }, /non-raw source URL/],
  ];
  for (const [label, mutate, pattern] of carrierCases) {
    const fixture = copyFixture("carrier-" + carrierCases.findIndex(c => c[0] === label));
    const restore = saveAndWrite(fixture, (object) => mutate(item(object, "fastdom")));
    rejects(label, () => validateFixture(fixture), pattern);
    restore();
    assert.doesNotThrow(() => validateFixture(fixture));
  }
  pass("all carrier mutations restore to a passing fixture");

  const blockedRecordFixture = copyFixture("blocked-record");
  const restoreBlockedRecord = saveAndWrite(blockedRecordFixture, (object) => {
    const entry = item(object, "lazy-val");
    entry.licenseTextSha256 = "f".repeat(64);
  });
  rejects("a blocked entry carrying a fabricated text hash is rejected", () =>
    validateFixture(blockedRecordFixture), /fabricated\/incomplete text record: lazy-val/);
  restoreBlockedRecord();

  // ---- Negative control: withdrawing a package's material ------------------
  const missingFixture = copyFixture("missing-material");
  const strictdomEntry = item(missingFixture.source, "strictdom");
  fs.unlinkSync(path.join(missingFixture.licenses, strictdomEntry.licenseFile));
  rejects("withdrawing one verified package's material turns validation red", () =>
    validateFixture(missingFixture), /missing|license source|ENOENT/i);
  pass("withdrawn material is detected (release cannot proceed with fewer than 14 texts)");

  // Demote the same package to blocked the way the review process would: no
  // material, no source record, explicit missingEvidence. The strict release
  // must then be blocked again and name five packages.
  const demoteFixture = copyFixture("demoted");
  const restoreDemote = saveAndWrite(demoteFixture, (object) => {
    const entry = item(object, "strictdom");
    entry.status = "blocked";
    entry.licenseFile = null;
    entry.licenseTextSha256 = null;
    entry.licenseSourceUrl = null;
    entry.missingEvidence = "Fixture: material withdrawn to prove the gate returns to blocked.";
    object.resolvedCount = 13;
    object.blockedCount = 5;
    // 【T117】demote 之后 excused 仍是 4（那四条 disposition 没动），
    // blocked 总数 = excused + 未签字，所以要从 4 改成 5；否则红在 summary
    // 不一致上，而不是这条要验的「降级回 blocked 会被拒」。
    object.excusedCount = 4;
    // 有未签字的阻塞 → 不再可发版。
    object.releaseEligible = false;
  });
  const demoted = validateFixture(demoteFixture, false);
  // 【T117】`blockedCount` 的语义是「**未签字**的阻塞」。四个上游缺文本的包
  // 仍带 disposition（没被这条 fixture 动过），所以它们进 `excusedCount`，
  // 未签字的只有刚降级的 strictdom 一条。
  assert.equal(demoted.blockedCount, 1);
  assert.equal(demoted.excusedCount, 4);
  assert.equal(demoted.blockedPackages.some(entry => entry.name === "strictdom"), true);
  rejects("demoting a package to blocked re-blocks the strict release and names it", () =>
    validateFixture(demoteFixture, true), /strictdom@1\.0\.1/);
  restoreDemote();
  pass("demoted fixture restored to 14 verified / 4 excused / 0 unexcused");

  // ---- Mutation: wrong licenseTextSha256 must redden, restore must be exact -
  const mutationFixture = copyFixture("hash-mutation");
  const originalManifestBytes = fs.readFileSync(mutationFixture.manifest);
  const originalHash = sha256(originalManifestBytes);
  const restoreMutation = saveAndWrite(mutationFixture, (object) => {
    const entry = item(object, "fastdom");
    entry.licenseTextSha256 = entry.licenseTextSha256.replace(/^[0-9a-f]/, entry.licenseTextSha256[0] === "0" ? "1" : "0");
  });
  rejects("one flipped hex digit in licenseTextSha256 is rejected (range-hash binding or file SHA-256)", () =>
    validateFixture(mutationFixture), /range hash differs|SHA-256 mismatch: fastdom/);
  restoreMutation();
  assert.equal(sha256(fs.readFileSync(mutationFixture.manifest)), originalHash);
  assert.deepEqual(validateFixture(mutationFixture).items.map(entry => entry.name).length, 14);
  pass("manifest bytes restored exactly (hash equal) and validation is green again");

  const materialMutationFixture = copyFixture("material-mutation");
  const fastdomMaterialPath = path.join(materialMutationFixture.licenses, item(real, "fastdom").licenseFile);
  const originalMaterial = fs.readFileSync(fastdomMaterialPath);
  const tampered = Buffer.from(originalMaterial);
  tampered[tampered.length - 2] ^= 1; // same-size mutation inside the text
  fs.writeFileSync(fastdomMaterialPath, tampered);
  rejects("same-size mutation of a README-carried material is rejected", () =>
    validateFixture(materialMutationFixture), /SHA-256 mismatch: fastdom/);
  fs.writeFileSync(fastdomMaterialPath, originalMaterial);
  assert.equal(sha256(fs.readFileSync(fastdomMaterialPath)), item(real, "fastdom").licenseTextSha256);
  pass("tampered material restored byte-exactly (cmp-equivalent hash check)");

  // ---- Notice regeneration mechanism (fixture-only, no real claim) --------
  // The shipped notice is generated at strict staging time from the vendor
  // THIRD-PARTY-NOTICES.txt plus the validated manifest. With four packages
  // still unresolved it must refuse (proven above). To prove the generation
  // path itself handles the new carrier records, resolve the four in a fixture
  // with obviously synthetic texts — mechanism proof only, never shipped.
  const MIT_FIXTURE = [
    "T11 TEST FIXTURE LICENSE (not a real package license)",
    "",
    "Copyright (c) 2026 T11 fixture contributors",
    "",
    "Permission is hereby granted, free of charge, to any person obtaining a copy",
    'of this software and associated documentation files (the "Software"), to deal',
    "in the Software without restriction, including without limitation the rights",
    "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
    "copies of the Software, and to permit persons to whom the Software is",
    "furnished to do so, subject to the following conditions:",
    "",
    "The above copyright notice and this permission notice shall be included in all",
    "copies or substantial portions of the Software.",
    "",
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
    "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
    "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
    "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
    "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN",
    "THE SOFTWARE.",
    "",
  ].join("\n");
  const ISC_FIXTURE = [
    "T11 TEST FIXTURE LICENSE (not a real package license)",
    "",
    "Copyright (c) 2026 T11 fixture contributors",
    "",
    "Permission to use, copy, modify, and/or distribute this software for any",
    "purpose with or without fee is hereby granted, provided that the above",
    "copyright notice and this permission notice appear in all copies.",
    "",
    'THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES',
    "WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF",
    "MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR",
    "ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES",
    "WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN",
    "ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF",
    "OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.",
    "",
  ].join("\n");
  const BSD2_FIXTURE = [
    "T11 TEST FIXTURE LICENSE (not a real package license)",
    "",
    "Copyright (c) 2026 T11 fixture contributors",
    "",
    "Redistribution and use in source and binary forms, with or without",
    "modification, are permitted provided that the following conditions are met:",
    "",
    "1. Redistributions of source code must retain the above copyright notice,",
    "   this list of conditions and the following disclaimer.",
    "2. Redistributions in binary form must reproduce the above copyright notice,",
    "   this list of conditions and the following disclaimer in the documentation",
    "   and/or other materials provided with the distribution.",
    "",
    'THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"',
    "AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE",
    "IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE",
    "ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE",
    "LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR",
    "CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF",
    "SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS",
    "INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN",
    "CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)",
    "ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE",
    "POSSIBILITY OF SUCH DAMAGE.",
    "",
  ].join("\n");
  const noticeFixtureTexts = {
    "@electron-internal/extract-zip": BSD2_FIXTURE,
    "lazy-val": MIT_FIXTURE,
    "ot-text-unicode": ISC_FIXTURE,
    "react-remove-scroll-bar": MIT_FIXTURE,
  };
  const noticeFixture = copyFixture("notice-regeneration");
  const noticeSource = fs.readFileSync(path.join(root, "genoffice/apps/shell/build/THIRD-PARTY-NOTICES.txt"), "utf8");
  const restoreNotice = saveAndWrite(noticeFixture, (object) => {
    const index = { "@electron-internal/extract-zip": 0, "lazy-val": 10, "ot-text-unicode": 12, "react-remove-scroll-bar": 14 };
    for (const [name, body] of Object.entries(noticeFixtureTexts)) {
      const entry = item(object, name);
      const file = name.replace(/[@/]/g, "_") + "-fixture.txt";
      fs.writeFileSync(path.join(noticeFixture.licenses, file), body);
      entry.status = "verified";
      entry.licenseSourceKind = "exact-upstream-source-file";
      entry.licenseSourceUrl = "https://raw.githubusercontent.com/t11-fixture/" + name + "/" + "0".repeat(40) + "/LICENSE";
      entry.licenseSourceVersion = entry.version + " (T11 notice-generation fixture)";
      entry.licenseFile = file;
      entry.licenseTextSha256 = sha256(Buffer.from(body, "utf8"));
      delete entry.missingEvidence;
      // 【T117】这条 fixture 给四个包**编造了**文本（只为验通知生成器），
      // 它们不再是例外；disposition 留着也不会被读（status 已是 verified），
      // 删掉是为了让 fixture 与真实规则一致：例外只属于 blocked 条目。
      delete entry.missingEvidenceDisposition;
      assert.equal(object.items[0], item(object, "@electron-internal/extract-zip"));
      assert.equal(index[name] !== undefined, true);
    }
    object.resolvedCount = 18;
    object.blockedCount = 0;
    object.excusedCount = 0;
    object.releaseEligible = true;
  });
  const completeFixture = validateFixture(noticeFixture, true);
  assert.equal(completeFixture.verifiedCount, 18);
  assert.equal(completeFixture.blockedCount, 0);
  const notice = stage.buildCompleteThirdPartyNotice(noticeSource, completeFixture);
  assertThirdPartySection(notice, "fastdom", "50c0de64f5cd5e39859b43f7eca7f5843fb3c3d5ac7e34a453e27419ad51e08c");
  assertThirdPartySection(notice, "lazy-val", sha256(Buffer.from(MIT_FIXTURE, "utf8")));
  assert.equal((notice.match(/T11 TEST FIXTURE LICENSE/g) || []).length, 4);
  stage.assertThirdPartyNoticeTextComplete(notice);
  stage.assertThirdPartyNoticeMatchesManifest(notice, completeFixture);
  pass("notice generator embeds manifest material + Source + License SHA-256 for all 18 (fixture-only)");
  // 【T117】原来这条断言是「拒绝真实 14/18 清单」——那在**写死阻塞**的策略下是对的。
  // 方向 A 之后，带签字的例外本身就是一种完整状态，真实清单**可以**出通知了；
  // 继续断言「拒绝」等于要求门禁永远不能放行 GenOffice，与已批准的方案相反。
  //
  // 换成两条互补的性质：
  //   1. 真实清单能出通知，且四个包在通知里是**显式例外**（写明上游未提供 + 依据），
  //      **不是**伪造的许可证文本；
  //   2. 未签字的清单仍然出不了通知（fail-closed 没被放宽）。
  const realNotice = stage.buildCompleteThirdPartyNotice(noticeSource, validation);
  stage.assertThirdPartyNoticeTextComplete(realNotice);
  // 【T117】这条断言守的是产品里改过的判据：完整性 = 14 原文 + 4 签字例外。
  // 改回 `verifiedCount === 18` 时它必须红 —— 我把判据换成 `verified+excused`
  // 时，正是 t87 的 afterPack 路径先撞出「带签字清单永远出不了合法通知」。
  stage.assertThirdPartyNoticeMatchesManifest(realNotice, validation);
  // 反向对照：把 exception 去掉（= 未签字），同一份通知必须被拒。
  assert.throws(
    () => stage.assertThirdPartyNoticeMatchesManifest(realNotice, { ...validation, blockedCount: 1 }),
    /incomplete license source manifest/i,
  );
  pass("complete-notice verifier accepts 14+signed-4 and rejects any unexcused blockage");
  for (const name of STILL_BLOCKED) {
    // 按**标题行**切分（72 个短横线在每节标题上下各有一条，用它切会把正文切掉）。
    const start = realNotice.indexOf("\n" + name + " v");
    assert.ok(start >= 0, name + " must appear in the real third-party notice");
    const rest = realNotice.slice(start + 1);
    const nextHeader = rest.slice(name.length).search(/\n[a-z@][^\n]* v\d/);
    const section = nextHeader < 0 ? rest : rest.slice(0, name.length + nextHeader + 1);
    assert.match(section, /NO LICENSE TEXT WAS SHIPPED WITH THIS VERSION/);
    assert.match(section, /Basis:/);
    assert.match(section, /Reviewed: \d{4}-\d{2}-\d{2}/);
    // 例外条目**不许**带一个"正文"去冒充原文本。
    assert.doesNotMatch(section, /License SHA-256:/);
  }
  assert.equal((realNotice.match(/NO LICENSE TEXT WAS SHIPPED WITH THIS VERSION/g) || []).length, 4);
  pass("real manifest now produces a complete notice: 14 texts + 4 signed, labelled exceptions");

  const unsignedValidationForNotice = stage.validateGenofficeLicenseManifest({
    manifestPath: unsignedPath, licenseRoot, vendorRoot: path.join(root, "genoffice"), repoRoot: root,
    requireComplete: false, expectedManifestSha256: unsignedSha,
  });
  assert.throws(() => stage.buildCompleteThirdPartyNotice(noticeSource, unsignedValidationForNotice), /unresolved/i);
  pass("the same generator still refuses an unsigned 14/18 manifest — no exception without a signature");
  try { fs.rmSync(unsignedPath, { force: true }); } catch { /* 清不掉不影响结论 */ }
  restoreNotice();
  for (const entry of completeFixture.items) {
    if (noticeFixtureTexts[entry.name]) continue;
    assert.ok(fs.existsSync(path.join(noticeFixture.licenses, entry.licenseFile)));
  }
  pass("notice fixture restored; suite never wrote fixture texts outside its temp dir");

  assert.equal(sha256(fs.readFileSync(manifestPath)), stage.GENOFFICE_LICENSE_MANIFEST_SHA256);
  pass("reviewed manifest was never modified by the suite");

  // ---- 【T117】白名单与例外形状：直接打函数，不靠集成路径 ----------------
  //
  // 这一节是**被变异验证逼出来的**。第一轮变异里 A/B/C/E/G 五条全绿，因为
  // `resolveChromiumLicense` 只在 `completeLicenseBundle` 分支里被调用，
  // 而 t11 的 fixture 从不走那条路；summary 的 `excusedCount` / `releaseEligible`
  // 两条判据也只是同义重复（所有能走到那里的路径都已被前面的检查挡住）。
  // 所以那些断言**分不清修没修** —— 现在改成直接打函数。
  {
    const tmpInner = path.join(temp, "whitelist");
    fs.mkdirSync(path.join(tmpInner, "app"), { recursive: true });
    fs.writeFileSync(path.join(tmpInner, "app", "package.json"), "{}");
    // app 内：必须放行。
    assert.equal(stage.isWithin(path.join(tmpInner, "app"), path.join(tmpInner, "app", "x.json")), true);
    // 仓库 node_modules 内：必须放行（pnpm 布局）。
    assert.equal(stage.isWithin(path.join(tmpInner, "node_modules"), path.join(tmpInner, "node_modules", ".pnpm", "electron@1", "package.json")), true);
    // 仓库其它位置：**不许**放行 —— 这正是 root 与 root/node_modules 的区别。
    assert.equal(stage.isWithin(path.join(tmpInner, "node_modules"), path.join(tmpInner, "genoffice", "LICENSE")), false);
    // 越级：不许。
    assert.equal(stage.isWithin(path.join(tmpInner, "app"), path.join(tmpInner, "app", "..", "outside.json")), false);
    // 同名前缀的兄弟目录（`..foo` / `app2`）：一律拒绝，与改造前保守谓词一致。
    assert.equal(stage.isWithin(path.join(tmpInner, "app"), path.join(tmpInner, "app2", "x")), false);
    assert.equal(stage.isWithin(path.join(tmpInner, "app"), path.join(tmpInner, "app-x", "x")), false);
    pass("isWithin whitelists exactly app / node_modules and no sibling-prefix directory");
  }
  // `resolveChromiumLicense` 本身：同一个仓库里，它必须落到白名单根之一。
  //
  // 注意这里**不**断言「返回的 root 一定包含 path」—— 那是一条同义重复：
  // `allowedRoots` 里 app 与 repoRoot/node_modules 互不包含，`find` 返回哪一条
  // 都能满足包含性（变异 I 证明了它永远绿）。真正的判别在别处：
  // 白名单本身由 A/B 守，返回的是哪个根由下游 `assertNativeVendorPath(root, …)`
  // 在真实暂存路径上守 —— 那一步不在本套件里（完整暂存需要 vendor 树）。
  {
    const appDir = path.join(root, "apps", "desktop");
    const info = stage.resolveChromiumLicense(appDir, root);
    const allowed = [appDir, path.join(root, "node_modules")];
    assert.ok(allowed.some(candidate => stage.isWithin(candidate, info.path)),
      "resolved Chromium license must sit under an approved root: " + info.path);
    assert.ok(fs.existsSync(info.path), "resolved Chromium license file must exist: " + info.path);
    assert.match(info.electronVersion, /^\d+\.\d+\.\d+/);
    pass("resolveChromiumLicense lands under an approved root");
    // 反向对照：给一个不存在的 app，解析必须失败而不是悄悄返回某个路径。
    assert.throws(() => stage.resolveChromiumLicense(path.join(temp, "no-such-app"), root), /Cannot find module|MODULE_NOT_FOUND/);
    pass("resolveChromiumLicense fails loudly when electron cannot be resolved from the app");
  }
  // 白名单的**上界**：electron 解析到一个既不在 app、也不在 `<repoRoot>/node_modules`
  // 的地方（这里故意放在 `<repoRoot>/genoffice/node_modules`）必须被拒。
  //
  // 这一条是 B 变异唯一能打中的形态：把白名单从 `repoRoot/node_modules` 放宽成
  // `repoRoot`，**在本仓库里不改变任何运行时行为**（没有真实路径落在 `genoffice/`
  // 下面），只有造出这种布局才分得清。之前 B 变异一直绿，就是因为没有这条对照。
  {
    const fakeRepo = path.join(temp, "fake-repo");
    // 解析起点：<repoRoot>/genoffice/apps/desktop —— 从它向上找会命中
    // <repoRoot>/genoffice/node_modules/electron，也就是白名单**外**。
    const escalationApp = path.join(fakeRepo, "genoffice", "apps", "desktop");
    const smuggled = path.join(fakeRepo, "genoffice", "node_modules", "electron");
    fs.mkdirSync(escalationApp, { recursive: true });
    fs.mkdirSync(smuggled, { recursive: true });
    fs.writeFileSync(path.join(escalationApp, "package.json"), "{}");
    fs.writeFileSync(path.join(smuggled, "package.json"), JSON.stringify({ name: "electron", version: "44.4.5" }));
    assert.throws(
      () => stage.resolveChromiumLicense(escalationApp, fakeRepo),
      /escapes its approved root/,
      "electron resolving into <repoRoot>/genoffice must be rejected, not accepted",
    );
    pass("resolveChromiumLicense rejects electron resolved outside app and <repoRoot>/node_modules");
  }
  // 清单汇总必须与条目**自洽**。真实清单里 excusedCount / releaseEligible 恰好是对的，
  // 所以「删掉那条判据」在真实清单上看不出差别（变异 E、G 就是这么活下来的）。
  // 这里逐个把汇总字段改成错的，断言每条判据**自己**能拒绝。
  {
    const SUMMARY_CASES = {
      "excusedCount": { patch: { excusedCount: 3 }, expect: "signed exceptions" },
      "releaseEligible": { patch: { releaseEligible: false }, expect: "releaseEligible=false" },
      "blockedCount": { patch: { blockedCount: 3 }, expect: "blocked entries" },
      "resolvedCount": { patch: { resolvedCount: 13 }, expect: "resolved entries" },
    };
    for (const [field, { patch, expect }] of Object.entries(SUMMARY_CASES)) {
      // 每个 case 一个独立目录：`copyFixture` 用名字做子目录，重名会互相覆盖，
      // 上一个 case 恢复的字节可能盖掉这一个 case 刚写的清单。
      const fixture = copyFixture("summary-" + field);
      const saved = fs.readFileSync(fixture.manifest);
      const object = JSON.parse(saved.toString("utf8"));
      Object.assign(object, patch);
      const mutated = Buffer.from(JSON.stringify(object, null, 2) + "\n", "utf8");
      fs.writeFileSync(fixture.manifest, mutated);
      try {
        // 判据的措辞各自不同（excusedCount 那条说的是 "signed exceptions"），
        // 所以每个 case 带自己的判别子串，而不是拿字段名去撞。
        assert.throws(() => validateFixture(fixture, false),
          (err) => typeof err?.message === "string" && err.message.includes(expect),
          "inconsistent " + field + " must be rejected by its own check");
        pass("manifest summary field rejected when inconsistent: " + field);
      } finally {
        fs.writeFileSync(fixture.manifest, saved);
      }
    }
  }
  {
    const BAD = {
      "kind 不对": { kind: "upstream-forgot", evidence: "x".repeat(60), basis: "y".repeat(30), reviewedAt: "2026-10-24" },
      "evidence 太短": { kind: "upstream-omitted-at-this-version", evidence: "too short", basis: "y".repeat(30), reviewedAt: "2026-10-24" },
      "basis 太短": { kind: "upstream-omitted-at-this-version", evidence: "x".repeat(60), basis: "short", reviewedAt: "2026-10-24" },
      "reviewedAt 不是日期": { kind: "upstream-omitted-at-this-version", evidence: "x".repeat(60), basis: "y".repeat(30), reviewedAt: "2026-10" },
      "evidence 照抄 missingEvidence": { kind: "upstream-omitted-at-this-version", evidence: "COPY", basis: "y".repeat(30), reviewedAt: "2026-10-24" },
      "null": null,
    };
    for (const [label, disposition] of Object.entries(BAD)) {
      const fixture = copyFixture("exception-shape");
      const savedItemName = "lazy-val";
      const source = item(fixture.source, savedItemName);
      const copy = disposition === null ? null : { ...disposition };
      if (copy && copy.evidence === "COPY") copy.evidence = source.missingEvidence;
      const restore = saveAndWrite(fixture, (object) => {
        const entry = item(object, savedItemName);
        if (copy === null) entry.missingEvidenceDisposition = null;
        else entry.missingEvidenceDisposition = copy;
      });
      try {
        assert.throws(() => validateFixture(fixture, false), /missing-license exception is malformed|lazy-val/i,
          "exception shape must be rejected: " + label);
        pass("malformed exception rejected: " + label);
      } finally {
        restore();
      }
    }
  }

  console.log("T11 license carrier smoke: " + total + "/" + total + " PASS");
  console.log("Release status: ELIGIBLE — 14 verified texts + 4 signed upstream-omission exceptions (18/18 accounted for).");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

function assertThirdPartySection(notice, name, expectedHash) {
  const section = stage.findNoticeSection(notice, [...stage.noticeSections(notice)]
    .map(entry => entry.title).find(title => title.startsWith(name + " v")));
  assert.ok(section, "notice section for " + name);
  assert.ok(section.body.includes("License SHA-256: " + expectedHash), "notice section for " + name + " carries its hash");
}
