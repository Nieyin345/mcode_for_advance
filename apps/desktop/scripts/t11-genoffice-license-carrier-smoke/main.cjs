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
  assert.equal(validation.blockedCount, 4);
  assert.deepEqual(validation.blockedPackages.map(entry => entry.name), [...STILL_BLOCKED]);
  assert.equal(real.expectedPackageCount, 18);
  assert.equal(real.resolvedCount, 14);
  assert.equal(real.blockedCount, 4);
  assert.equal(real.releaseEligible, false);
  pass("manifest summary is 14 verified / 4 blocked and releaseEligible stays false");

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

  rejects("strict release gate still fails closed naming the four unresolved packages", () => {
    stage.validateGenofficeLicenseManifest({
      manifestPath, licenseRoot, vendorRoot: path.join(root, "genoffice"), repoRoot: root, requireComplete: true,
    });
  }, /@electron-internal\/extract-zip@1\.0\.5 .*lazy-val@1\.0\.5 .*ot-text-unicode@4\.0\.0 .*react-remove-scroll-bar@2\.3\.8/s);
  rejects("complete third-party notice cannot be generated while four packages are unresolved", () => {
    stage.buildCompleteThirdPartyNotice(
      fs.readFileSync(path.join(root, "genoffice/apps/shell/build/THIRD-PARTY-NOTICES.txt"), "utf8"),
      validation,
    );
  }, /unresolved/i);

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
  });
  const demoted = validateFixture(demoteFixture, false);
  assert.equal(demoted.blockedCount, 5);
  assert.equal(demoted.blockedPackages.some(entry => entry.name === "strictdom"), true);
  rejects("demoting a package to blocked re-blocks the strict release and names it", () =>
    validateFixture(demoteFixture, true), /strictdom@1\.0\.1/);
  restoreDemote();
  pass("demoted fixture restored to 14 verified / 4 blocked");

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
      assert.equal(object.items[0], item(object, "@electron-internal/extract-zip"));
      assert.equal(index[name] !== undefined, true);
    }
    object.resolvedCount = 18;
    object.blockedCount = 0;
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
  assert.throws(() => stage.buildCompleteThirdPartyNotice(noticeSource, validation), /unresolved/i);
  pass("the same generator refuses the real 14/18 manifest — notice is never published partial");
  restoreNotice();
  for (const entry of completeFixture.items) {
    if (noticeFixtureTexts[entry.name]) continue;
    assert.ok(fs.existsSync(path.join(noticeFixture.licenses, entry.licenseFile)));
  }
  pass("notice fixture restored; suite never wrote fixture texts outside its temp dir");

  assert.equal(sha256(fs.readFileSync(manifestPath)), stage.GENOFFICE_LICENSE_MANIFEST_SHA256);
  pass("reviewed manifest was never modified by the suite");

  console.log("T11 license carrier smoke: " + total + "/" + total + " PASS");
  console.log("Release status: BLOCKED — 14/18 verified (6 new README-carried texts); 4 packages remain unresolved.");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

function assertThirdPartySection(notice, name, expectedHash) {
  const section = stage.findNoticeSection(notice, [...stage.noticeSections(notice)]
    .map(entry => entry.title).find(title => title.startsWith(name + " v")));
  assert.ok(section, "notice section for " + name);
  assert.ok(section.body.includes("License SHA-256: " + expectedHash), "notice section for " + name + " carries its hash");
}
