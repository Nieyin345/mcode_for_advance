"use strict";
/**
 * ARC-007: opt-in GenOffice CLI and original six-editor release staging.
 *
 * Default CI installs must remain buildable without the ignored vendor checkout,
 * and must never silently ship an incomplete/stale GenOffice sidecar. Explicit
 * MCODE_INCLUDE_GENOFFICE_BUNDLE=1 requires a reviewed local vendor snapshot.
 * By default we stage only the CLI bundle/dependencies/PDFium/notices. A second
 * explicit opt-in stages the six already-built ORIGINAL vendor renderer assets
 * (not their separate Electron shell/agent loop). Missing editor outputs fail
 * before touching any previously staged resources.
 *
 * electron-builder extraResources copies .tmp/genoffice-release => resources/genoffice.
 * All paths are app-local; never write to the user's Electron data directory.
 */
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { isAbsolute, join, resolve, relative, sep, dirname } = require("node:path");
const EDITOR_APPS = Object.freeze(["docs", "sheets", "slides", "pdf", "markdown", "html"]);
/**
 * Editor kinds whose vendor `out/preload/index.js` the shipped host actually
 * mounts. This mirrors the runtime contract in
 * `src/main/document/genofficeViewFactories.ts` (`NativeKind`): the five
 * kinds below get a vendor `WebContentsView` whose `preloadPath` is
 * `apps/<kind>/out/preload/index.js`. `docs` is deliberately absent — the
 * Docs view is created by `documentViewHost.ts` with Mcode's own
 * `out/main/documentViewPreload.js` bridge (which compiles the vendor
 * `mcode-view.ts` source in), so shipping the vendor's standalone docs
 * preload would only add an unused, over-privileged surface. The release
 * smoke asserts this list equals the runtime kinds, so adding a native kind
 * there without staging its preload fails the build instead of shipping a
 * degraded editor.
 */
const NATIVE_PRELOAD_KINDS = Object.freeze(["pdf", "markdown", "html", "sheets", "slides"]);
const GENOFFICE_UPSTREAM_REPOSITORY = "https://github.com/genspark-ai/genoffice";
const GENOFFICE_UPSTREAM_NOTICE = "genoffice/apps/shell/build/THIRD-PARTY-NOTICES.txt";
const GENOFFICE_LICENSE_MANIFEST_SHA256 = "394d3467ae45450d2a41bbb44c72e3386fc501d9eab3bc41ea3edfecc9025108";
const GENOFFICE_LICENSE_MANIFEST_FORMAT = "mcode.genoffice.third-party-license-sources.v2";
/**
 * T11 carrier policy (roadmap: T9 evidence). A license text is admissible only
 * through one of two exact carriers:
 *   1. `exact-upstream-source-file`: a standalone license file fetched from a
 *      pinned raw.githubusercontent.com revision (the original T87 rule).
 *   2. `exact-npm-release-readme-section`: the complete license section embedded
 *      in the README of the exact SRI-verified npm release tarball, recorded with
 *      the README path/heading, whole-README SHA-256, the section's byte range and
 *      the range's SHA-256. This is a different carrier, not a lower bar: the
 *      bytes are bound to the published artifact and must contain every element
 *      of the declared SPDX license.
 * Both carriers feed the same per-SPDX completeness check below; a text missing
 * the retention/notice clause (e.g. ot-text-unicode 4.0.0's README) is rejected
 * even though it contains a grant and a disclaimer.
 */
const GENOFFICE_LICENSE_SOURCE_KINDS = Object.freeze([
  "exact-upstream-source-file",
  "exact-npm-release-readme-section",
]);
/** Required elements per SPDX id, matched against whitespace-normalized text.
 * Copyright notice, grant, retention (the notice must be preserved), and
 * warranty disclaimer are the four operative parts of these permissive
 * licenses. Apache-2.0 additionally needs its terms header/end and liability
 * section rather than a "retention" sentence. */
const GENOFFICE_LICENSE_ELEMENTS = Object.freeze({
  MIT: Object.freeze([
    ["copyright notice", /copyright/i],
    ["grant", /permission is hereby granted, free of charge/i],
    ["retention notice", /the above copyright notice and this permission notice shall be included in all copies or substantial portions of the software/i],
    ["warranty disclaimer", /the software is provided .{0,40}?as is.{0,200}?without warranty/i],
  ]),
  ISC: Object.freeze([
    ["copyright notice", /copyright/i],
    ["grant", /permission to use, copy, modify, and\/or distribute this software/i],
    ["retention notice", /copyright notice and this permission notice appear in all copies/i],
    ["warranty disclaimer", /the software is provided "as is" and the author disclaims all warranties/i],
  ]),
  "BSD-2-Clause": Object.freeze([
    ["copyright notice", /copyright/i],
    ["grant", /redistribution and use in source and binary forms/i],
    ["retention notice", /this list of conditions and the following disclaimer/i],
    ["warranty disclaimer", /this software is provided by the copyright holders and contributors/i],
  ]),
  "Apache-2.0": Object.freeze([
    ["license title", /apache license/i],
    ["version", /version 2\.0, january 2004/i],
    ["terms of use", /terms and conditions for use, reproduction, and distribution/i],
    ["copyright grant", /grant of copyright license/i],
    ["liability", /limitation of liability/i],
    ["terms end", /end of terms and conditions/i],
  ]),
});
function missingLicenseElements(spdx, text) {
  const checks = GENOFFICE_LICENSE_ELEMENTS[spdx];
  if (!checks) return [];
  const normalized = text.replace(/\s+/g, " ");
  return checks.filter(([, pattern]) => !pattern.test(normalized)).map(([label]) => label);
}
function assertGenofficeLicenseCarrier(item, index) {
  const fail = (why) => {
    throw new Error("GenOffice verified license entry contains an inadmissible source carrier (" + why +
      ") at package index " + (index + 1) + ": " + item.name);
  };
  if (!GENOFFICE_LICENSE_SOURCE_KINDS.includes(item.licenseSourceKind)) fail("unknown licenseSourceKind");
  if (typeof item.licenseSourceVersion !== "string" || !item.licenseSourceVersion) fail("missing licenseSourceVersion");
  if (typeof item.licenseSourceUrl !== "string" || !item.licenseSourceUrl.startsWith("https://")) fail("missing https licenseSourceUrl");
  if (item.licenseSourceKind === "exact-upstream-source-file") {
    if (!item.licenseSourceUrl.startsWith("https://raw.githubusercontent.com/")) fail("non-raw source URL");
    return;
  }
  // exact-npm-release-readme-section: the bytes must be bound to the exact
  // SRI-verified tarball, not to a web page or a similar release.
  if (item.licenseSourceUrl !== item.npmTarballUrl) fail("README carrier source is not the exact npm tarball");
  if (item.licenseSourceReadmePath !== "package/README.md" && item.licenseSourceReadmePath !== "package/readme.md") {
    fail("README carrier must name package/README.md");
  }
  if (typeof item.licenseSourceReadmeHeading !== "string"
      || !/^#{1,4}[ \t]*(?:licen[cs]e)[ \t]*$/i.test(item.licenseSourceReadmeHeading)) {
    fail("README carrier heading is not a License heading");
  }
  if (typeof item.licenseSourceReadmeSha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.licenseSourceReadmeSha256)) {
    fail("README carrier lacks whole-README SHA-256");
  }
  const range = item.licenseSourceByteRange;
  if (!range || typeof range !== "object" || Array.isArray(range)
      || !Number.isInteger(range.start) || !Number.isInteger(range.end) || !Number.isInteger(range.length)
      || range.start < 0 || range.length < 1 || range.end !== range.start + range.length
      || !Number.isInteger(item.licenseSourceReadmeBytes) || item.licenseSourceReadmeBytes < range.end) {
    fail("README carrier byte range is missing or inconsistent");
  }
  if (item.licenseSourceByteRangeSha256 !== item.licenseTextSha256) {
    fail("README carrier range hash differs from the license text hash");
  }
  const proof = item.licenseSourceVerification;
  if (!proof || typeof proof !== "object" || Array.isArray(proof) || proof.readmeSha256 !== item.licenseSourceReadmeSha256) {
    fail("README carrier lacks a README byte-equality proof");
  }
  if (proof.kind === "exact-commit-readme-equal") {
    if (typeof proof.revision !== "string" || !/^[0-9a-f]{40}$/.test(proof.revision) || proof.revisionKind !== "exact-tag-commit") {
      fail("exact-commit proof is malformed");
    }
  } else if (proof.kind === "public-commit-readme-equal-weaker-chain") {
    // Published npm gitHead is not retrievable for a few old packages. Accepting
    // those requires a named public upstream commit whose README is byte-equal
    // plus an explicit reviewer signoff; it may never be silent.
    if (typeof proof.commit !== "string" || !/^[0-9a-f]{40}$/.test(proof.commit)
        || proof.commitClass !== "public-upstream-master-ancestor"
        || proof.publishedGitHeadRetrievable !== false
        || typeof proof.reviewSignoff !== "string" || proof.reviewSignoff.trim().length < 40) {
      fail("weaker README proof lacks commit/class/signoff");
    }
  } else {
    fail("unknown README verification kind");
  }
}

/** `candidate` 是否落在 `root` 里（字面判据，不跟符号链接）。
 * 与改造前的 assertWithin 同一套谓词：`startsWith("..")` 连 `..foo` 这类
 * 同名前缀的兄弟目录也一并拒绝，是刻意保守，不是笔误。 */
function isWithin(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return !(isAbsolute(rel) || rel.startsWith("..") || rel.startsWith(sep) || rel === "..");
}
function assertWithin(root, candidate) {
  if (!isWithin(root, candidate)) {
    throw new Error("GenOffice resource path escapes its approved root");
  }
}
function assertVendorTreeSafe(repo, dir) {
  // cpSync(dereference:true) would otherwise follow a nested junction into
  // arbitrary workstation files, even when the top-level source is trusted.
  assertWithin(repo, fs.realpathSync.native(dir));
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("unsafe vendor symlink/junction in GenOffice CLI dependencies: " + entry.name);
    }
    if (entry.isDirectory()) assertVendorTreeSafe(repo, child);
  }
}
/** Inspect every path component before copying original vendor resources.
 * A junction apps/docs/out -> apps/html/out can stay inside the approved Git
 * checkout while substituting the wrong native editor. CLI node_modules can
 * also point to unreviewed sibling directories inside the *Mcode* repo, which
 * the old assertWithin(repo, realpath) erroneously accepted. Check physical
 * identity for both, not just resolved path containment or nested children. */
function assertNativeVendorPath(vendor, input) {
  assertWithin(vendor, input);
  const rootInfo = fs.lstatSync(vendor);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("GenOffice native vendor root unsafe symlink/junction: " + vendor);
  }
  const parts = relative(vendor, input).split(sep).filter(Boolean);
  let current = vendor;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    let s;
    try { s = fs.lstatSync(current); }
    catch (err) {
      if (err?.code === "ENOENT") throw new Error("GenOffice original renderer/resource missing: " + current);
      throw err;
    }
    if (s.isSymbolicLink() || (index < parts.length - 1 && !s.isDirectory())) {
      throw new Error("GenOffice native resource unsafe ancestor symlink/junction: " + current);
    }
  }
}
function fileReady(file, label) {
  try {
    if (fs.statSync(file).isFile() && fs.statSync(file).size > 0) return;
  } catch {}
  throw new Error(`GenOffice bundle missing required ${label}: ${file}`);
}
function dirReady(dir, label) {
  try {
    if (fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length > 0) return;
  } catch {}
  throw new Error(`GenOffice bundle missing required ${label}: ${dir}`);
}
function noticePackagesWithoutLicenseText(text) {
  const sections = [...text.matchAll(/\n-{72}\n([^\n]+)\n-{72}\n([\s\S]*?)(?=\n-{72}\n|$)/g)];
  return sections
    .filter(([, title, body]) => / v[^\n]+ — /.test(title) && body.trimStart().startsWith("Licensed under "))
    .map(([, title]) => title);
}
function assertThirdPartyNoticeTextComplete(text) {
  for (const term of ["@embedpdf/pdfium", "Copyright 2014 PDFium Authors", "Apache License"]) {
    if (!text.includes(term)) throw new Error("GenOffice third-party notice is missing required PDFium license term: " + term);
  }
  const missing = noticePackagesWithoutLicenseText(text);
  if (missing.length) {
    throw new Error("GenOffice third-party notice lacks full license text for " + missing.length + " package(s): " +
      missing.join(", ") + ". Prerequisite: add verified exact-source license texts and regenerate the notice from the pinned clean GenOffice source; never synthesize a license file from an SPDX label or from a README fragment that lacks required license elements.");
  }
  return { packageSections: [...text.matchAll(/\n-{72}\n([^\n]+ v[^\n]+ — )/g)].length, missingLicenseText: [] };
}
function assertThirdPartyNoticeComplete(file) {
  return assertThirdPartyNoticeTextComplete(fs.readFileSync(file, "utf8"));
}
/**
 * ⚠️ 这张表**不是**「发布物里有哪些包」，也**不是**「genoffice 的运行时依赖」。
 *
 * 它是一张**人工复核过的「我们需要自己留一份许可证原文」的清单** —— 但**它不是
 * 「上游 notice 里缺正文的那些」的机械投影**。2026-10-24 实测这个关系：
 *
 * | 集合 | 数量 |
 * |---|---|
 * | 上游 `THIRD-PARTY-NOTICES.txt` 里的包（25581 行，其中 521 段带完整条款） | 570 |
 * | 上游 notice 里**正文不足一行**的段落 | **15** |
 * | 本清单 | **18** |
 *
 * 两个集合**互不包含**：
 *  - 本清单里 `fastdom` / `hash.js` / `isarray` / `lazy-val` / `strictdom` **在上游
 *    notice 里是有正文的** —— 它们被收进来是因为**正文不够 SPDX 要求的全部要素**
 *    （见 `GENOFFICE_LICENSE_ELEMENTS` 的四条正则），不是因为"没有正文"；
 *  - 上游 notice 里 `@fluentui/react-icons` / `@genspark/cli` 正文同样不足，**却没被收**。
 *
 * **所以「它不在 notice 的缺正文名单里」不能证明它该出清单，「它在 notice 里」也不能
 * 单独证明它该进清单。** 出清单的唯一依据是：**这个包的许可证原文已经按
 * `GENOFFICE_LICENSE_SOURCE_KINDS` 的某一种载体登记齐了**（`status: "verified"`）。
 *
 * ### 2026-10-24 差点删错一条
 *
 * `@electron-internal/extract-zip` 的依赖链是 `electron` → 七个 editor app 的
 * **devDependencies**，看起来「不属于 genoffice」，于是被删掉了。
 *
 * 但**上游 notice 第 858 行确实列了它**（那一段只有 `Licensed under BSD-2-Clause.`
 * 加一个链接，正文不足 —— 正是需要补原文的形态）。
 *
 * **删掉它的后果不是「少一个无关项」**：发布的 notice 里那一段会永远没有正文，
 * 而门禁不再拦 —— 从「被拦住」变成「悄悄少一节」。
 * `t11-genoffice-license-carrier-smoke` 当场抓住：
 * `generated notice still has incomplete package license sections`。
 *
 * **教训**：「这个不该在这里」这个判断，依据必须是**「谁在用它」**（上游 notice 列了它、
 * 发布的 notice 会少一节），不能是**「它是什么」**（运行时依赖还是 devDependency）。
 */
const REQUIRED_GENOFFICE_LICENSE_PACKAGES = Object.freeze([
  ["@electron-internal/extract-zip", "1.0.5", "BSD-2-Clause"],
  ["@napi-rs/canvas-win32-x64-msvc", "1.0.3", "MIT"],
  ["@nodable/entities", "3.0.0", "MIT"],
  ["@univerjs/protocol", "0.25.1", "Apache-2.0"],
  ["emoji-regex", "8.0.0", "MIT"],
  ["fastdom", "1.0.12", "MIT"],
  ["franc-min", "6.2.0", "MIT"],
  ["hash.js", "1.1.7", "MIT"],
  ["is-potential-custom-element-name", "1.0.1", "MIT"],
  ["isarray", "1.0.0", "MIT"],
  ["lazy-val", "1.0.5", "MIT"],
  ["ot-json1", "1.0.2", "ISC"],
  ["ot-text-unicode", "4.0.0", "ISC"],
  ["punycode", "2.3.1", "MIT"],
  ["react-remove-scroll-bar", "2.3.8", "MIT"],
  ["saxes", "6.0.0", "ISC"],
  ["strictdom", "1.0.1", "MIT"],
  ["unicount", "1.1.0", "ISC"],
].map(([name, version, spdx]) => Object.freeze({ name, version, spdx })));

function validateGenofficeLicenseManifest({
  manifestPath, licenseRoot, vendorRoot, repoRoot, requireComplete = true,
  expectedManifestSha256 = GENOFFICE_LICENSE_MANIFEST_SHA256,
} = {}) {
  if (typeof manifestPath !== "string" || !manifestPath) {
    throw new Error("GenOffice full license bundle requires its source manifest");
  }
  const manifestFile = resolve(manifestPath);
  if (repoRoot) assertNativeVendorPath(resolve(repoRoot), manifestFile);
  fileReady(manifestFile, "GenOffice license source manifest");
  if (typeof expectedManifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(expectedManifestSha256)
      || hashFile(manifestFile) !== expectedManifestSha256) {
    throw new Error("GenOffice license source manifest SHA-256 differs from the reviewed source inventory");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const root = resolve(licenseRoot ?? join(dirname(manifestFile), "licenses"));
  if (manifest.format !== GENOFFICE_LICENSE_MANIFEST_FORMAT
      || manifest.repository !== GENOFFICE_UPSTREAM_REPOSITORY
      || manifest.sourceNotice !== GENOFFICE_UPSTREAM_NOTICE
      || manifest.expectedPackageCount !== REQUIRED_GENOFFICE_LICENSE_PACKAGES.length
      || !Array.isArray(manifest.items) || manifest.items.length !== REQUIRED_GENOFFICE_LICENSE_PACKAGES.length) {
    throw new Error("GenOffice license source manifest schema/package inventory mismatch");
  }
  const verified = [];
  const blocked = [];
  /**
   * 【T117】**上游在该版本未提供许可证文本**的显式例外。
   *
   * 与 `blocked` 的区别只有一件事：条目上带了 `missingEvidenceDisposition`，
   * 也就是**有人逐条签过字**，说明「查过了，这个版本上游确实没有可用文本」。
   *
   * ⚠️ **它不是「放行所有 blocked」的开关。** 没有 disposition 的 blocked 条目
   * 仍然走原来的 `requireComplete` 拒绝路径 —— 见下面的判断。这样「加一条例外」
   * 必须逐包写理由，不会变成一条捷径。
   */
  const excused = [];
  for (let index = 0; index < REQUIRED_GENOFFICE_LICENSE_PACKAGES.length; index++) {
    const expected = REQUIRED_GENOFFICE_LICENSE_PACKAGES[index];
    const item = manifest.items[index];
    if (!item || item.name !== expected.name || item.version !== expected.version || item.spdx !== expected.spdx
        || item.packagePath !== "node_modules/" + expected.name + "/package.json"
        || typeof item.upstreamRepository !== "string" || !item.upstreamRepository.startsWith("https://")
        || typeof item.upstreamRevision !== "string" || !item.upstreamRevision
        || typeof item.upstreamSourceUrl !== "string" || !item.upstreamSourceUrl.startsWith("https://")
        || typeof item.npmTarballUrl !== "string" || !item.npmTarballUrl.startsWith("https://registry.npmjs.org/")
        || typeof item.npmTarballIntegrity !== "string"
        || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(item.npmTarballIntegrity)
        || item.npmTarballIntegrityVerified !== true
        || !Array.isArray(item.npmTarballLegalLicenseEntries)
        || !["npm-gitHead", "release-tag-plus-source-commit"].includes(item.upstreamRevisionKind)) {
      throw new Error("GenOffice license source identity/version/SPDX mismatch at package index " + (index + 1));
    }
    if (vendorRoot) {
      const packageFile = resolve(vendorRoot, item.packagePath);
      assertNativeVendorPath(resolve(vendorRoot), packageFile);
      const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
      const actualSpdx = typeof pkg.license === "string" ? pkg.license : pkg.license?.type;
      if (pkg.name !== item.name || pkg.version !== item.version || actualSpdx !== item.spdx) {
        throw new Error("GenOffice installed package metadata differs from license source manifest: " + item.name);
      }
    }
    if (item.status === "blocked") {
      if (item.licenseFile !== null || item.licenseTextSha256 !== null || item.licenseSourceUrl !== null
          || typeof item.missingEvidence !== "string" || !item.missingEvidence) {
        throw new Error("GenOffice blocked license entry contains a fabricated/incomplete text record: " + item.name);
      }
      // 【T117】带 disposition 的进 `excused`（逐条签字的上游缺失例外），
      // 不带的进 `blocked`（仍然 fail-closed）。
      const disposition = item.missingEvidenceDisposition;
      if (disposition !== undefined) {
        const shapeOk = disposition !== null && typeof disposition === "object"
          && disposition.kind === "upstream-omitted-at-this-version"
          && typeof disposition.evidence === "string" && disposition.evidence.trim().length >= 40
          && typeof disposition.basis === "string" && disposition.basis.trim().length >= 20
          && typeof disposition.reviewedAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(disposition.reviewedAt)
          // 例外**必须**依附在一条真实的 missingEvidence 上 —— 不能拿它顶替证据。
          && disposition.evidence !== item.missingEvidence;
        if (!shapeOk) {
          throw new Error("GenOffice missing-license exception is malformed: " + item.name
            + " (need kind=upstream-omitted-at-this-version, evidence>=40 chars and distinct from missingEvidence,"
            + " basis>=20 chars, reviewedAt=YYYY-MM-DD)");
        }
        excused.push({
          name: item.name, version: item.version, spdx: item.spdx,
          evidence: item.missingEvidence, disposition,
        });
        continue;
      }
      blocked.push({ name: item.name, version: item.version, spdx: item.spdx, evidence: item.missingEvidence });
      continue;
    }
    if (item.status !== "verified" || typeof item.licenseFile !== "string"
        || item.licenseFile !== item.licenseFile.split(/[\\/]/).pop()
        || item.licenseFile === "." || item.licenseFile === ".."
        || typeof item.licenseTextSha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.licenseTextSha256)) {
      throw new Error("GenOffice verified license entry lacks exact source/file/hash metadata: " + item.name);
    }
    assertGenofficeLicenseCarrier(item, index);
    const licenseFile = resolve(root, item.licenseFile);
    assertWithin(root, licenseFile);
    if (repoRoot) assertNativeVendorPath(resolve(repoRoot), licenseFile);
    fileReady(licenseFile, "full upstream license text for " + item.name);
    const text = fs.readFileSync(licenseFile, "utf8");
    if (text.trim().length < 150 || /^(?:Licensed under |SPDX-License-Identifier:)/i.test(text.trim())
        || !/(?:Permission is hereby granted|Permission to use, copy|Apache License|Redistribution and use)/i.test(text)) {
      throw new Error("GenOffice license source is not a full license text: " + item.name);
    }
    const missingElements = missingLicenseElements(item.spdx, text);
    if (missingElements.length) {
      throw new Error("GenOffice license source is missing " + item.spdx + " element(s) " +
        missingElements.join(", ") + ": " + item.name +
        ". A grant without the retention notice (or any other operative element) is not an executable full license.");
    }
    const actualHash = hashFile(licenseFile);
    if (actualHash !== item.licenseTextSha256) {
      throw new Error("GenOffice license source SHA-256 mismatch: " + item.name);
    }
    verified.push({ ...item, licensePath: licenseFile, licenseText: text });
  }
  // 【T117】`blockedCount` 仍是清单里 status=blocked 的**总数**（verified + excused + blocked
  // 三者之和要覆盖它），而 `releaseEligible` 现在说的是「没有**未签字**的阻塞」。
  // 这两条分开写，是为了让「清单统计」和「能不能发版」不再混成同一个数。
  //
  // 每条判据单独报错并带上实际数字：否则变异时「换一个条件」会得到同一句话，
  // 断言分不清是哪条在守（我自己踩过：删掉 excusedCount 判据套件仍然全绿，
  // 因为同一行的 releaseEligible 判据先命中）。
  if (manifest.resolvedCount !== verified.length) {
    throw new Error("GenOffice license source manifest reports " + manifest.resolvedCount
      + " resolved entries but " + verified.length + " carry a verified text");
  }
  if (manifest.excusedCount !== excused.length) {
    throw new Error("GenOffice license source manifest reports " + manifest.excusedCount
      + " signed exceptions but " + excused.length + " entries carry a missingEvidenceDisposition");
  }
  if (manifest.blockedCount !== excused.length + blocked.length) {
    throw new Error("GenOffice license source manifest reports " + manifest.blockedCount
      + " blocked entries but " + (excused.length + blocked.length) + " are blocked ("
      + excused.length + " excused, " + blocked.length + " unexcused)");
  }
  if (manifest.releaseEligible !== (blocked.length === 0)) {
    throw new Error("GenOffice license source manifest releaseEligible=" + manifest.releaseEligible
      + " but " + blocked.length + " package(s) are blocked without a signed exception");
  }
  if (requireComplete && blocked.length) {
    throw new Error("GenOffice strict release blocked: full upstream license text is unresolved for " +
      blocked.map(item => item.name + "@" + item.version + " (" + item.spdx + ")").join(", ") +
      ". Do not infer license text from SPDX metadata or a similar release."
      + " (Entries may be excused only with a reviewed missingEvidenceDisposition; none was present for these.)");
  }
  return {
    manifest, manifestPath: manifestFile, licenseRoot: root,
    items: verified, verifiedCount: verified.length,
    blockedPackages: blocked, blockedCount: blocked.length,
    excusedPackages: excused, excusedCount: excused.length,
  };
}

/**
 * The vendor notice separates sections with a 72-dash rule:
 *   \n----…----\n<name> v<version> — <SPDX>\n----…----\n<body>
 * The earlier `split(/(?=^-{72}$)/m)` chunking put each title in the chunk that
 * *starts* at its opening rule but ended the chunk at the closing rule, so title
 * and body never shared a chunk and the full-section regex could never match a
 * real notice (it only ever ran after the "unresolved" throw). Match whole
 * sections with their body instead; the lookahead keeps the trailing separator
 * out of the body so replacements compose from exact offsets.
 */
const NOTICE_SECTION_PATTERN = /\r?\n-{72}\r?\n([^\r\n]+)\r?\n-{72}\r?\n([\s\S]*?)(?=\r?\n-{72}\r?\n|$)/g;
function* noticeSections(text) {
  for (const match of text.matchAll(NOTICE_SECTION_PATTERN)) {
    const bodyEnd = match.index + match[0].length;
    yield { title: match[1], body: match[2], bodyStart: bodyEnd - match[2].length, bodyEnd };
  }
}
function findNoticeSection(text, title) {
  for (const section of noticeSections(text)) {
    if (section.title === title) return section;
  }
  return null;
}
function assertThirdPartyNoticeMatchesManifest(text, validation) {
  // 【T117】完整性的判据是「18 个包**全部有交代**」：14 份原文 + 4 条签字例外。
  // 原来要求 `verifiedCount === 18`，那会让带签字的清单永远出不了合法通知 ——
  // 也就等于 T117 的方案根本无法发布。改成 verified + excused 覆盖全量，
  // 且**没有任何未签字的阻塞**。
  if (!validation || validation.blockedCount !== 0
      || validation.verifiedCount + (validation.excusedCount ?? 0) !== REQUIRED_GENOFFICE_LICENSE_PACKAGES.length) {
    throw new Error("GenOffice third-party notice cannot be verified against an incomplete license source manifest");
  }
  for (const item of validation.items) {
    const title = item.name + " v" + item.version + " — " + item.spdx;
    const section = findNoticeSection(text, title);
    if (!section || !section.body.includes(item.licenseText.trimEnd())
        || !section.body.includes("Source: " + item.licenseSourceUrl)
        || !section.body.includes("License SHA-256: " + item.licenseTextSha256)) {
      throw new Error("GenOffice packaged notice does not contain exact full license/source material: " + item.name);
    }
  }
  return { matchedCount: validation.items.length };
}

function buildCompleteThirdPartyNotice(sourceText, validation) {
  // 【T117】`blockedCount` 现在包含 excused 条目（清单统计口径），所以判据是
  // 「没有**未签字**的阻塞」而不是「blockedCount === 0」。
  if (!validation || validation.blockedCount !== 0
      || validation.verifiedCount + (validation.excusedCount ?? 0) !== REQUIRED_GENOFFICE_LICENSE_PACKAGES.length) {
    throw new Error("Cannot generate a complete GenOffice third-party notice while any upstream license text is unresolved");
  }
  const byTitle = new Map(validation.items.map(item => [
    item.name + " v" + item.version + " — " + item.spdx, item,
  ]));
  // 【T117】上游在该版本没有许可证文本的包：正文不可能是原文，**如实写缺失**。
  // 这是这条通知里唯一允许「不贴全文」的情形，而且每个都必须带 disposition 的理由。
  const excusedByTitle = new Map((validation.excusedPackages ?? []).map(item => [
    item.name + " v" + item.version + " — " + item.spdx, item,
  ]));
  let found = 0;
  let cursor = 0;
  let replaced = "";
  for (const section of noticeSections(sourceText)) {
    const excused = excusedByTitle.get(section.title);
    if (excused) {
      found++;
      replaced += sourceText.slice(cursor, section.bodyStart);
      replaced +=
        "NO LICENSE TEXT WAS SHIPPED WITH THIS VERSION.\n\n" +
        "This package declares " + excused.spdx + " in its own package.json, but the SRI-verified " +
        excused.version + " npm tarball and its upstream tree contain no license file, and no text from a " +
        "later release may be substituted for it.\n\n" +
        "Why the upstream text could not be used: " + excused.evidence + "\n\n" +
        "Basis: " + excused.disposition.basis + "\n" +
        "Reviewed: " + excused.disposition.reviewedAt + "\n";
      cursor = section.bodyEnd;
      continue;
    }
    const item = byTitle.get(section.title);
    if (!item) continue;
    found++;
    replaced += sourceText.slice(cursor, section.bodyStart);
    replaced += item.licenseText.trimEnd() + "\n\nSource: " + item.licenseSourceUrl +
      "\nSource version: " + item.licenseSourceVersion +
      "\nLicense SHA-256: " + item.licenseTextSha256 + "\n";
    cursor = section.bodyEnd;
  }
  if (found !== byTitle.size + excusedByTitle.size) {
    throw new Error("GenOffice third-party notice package sections do not match the verified source manifest");
  }
  const text = replaced + sourceText.slice(cursor);
  const missing = noticePackagesWithoutLicenseText(text);
  if (missing.length) throw new Error("GenOffice generated notice still has incomplete package license sections: " + missing.join(", "));
  for (const item of validation.items) {
    const title = item.name + " v" + item.version + " — " + item.spdx;
    const section = findNoticeSection(text, title);
    if (!section || !section.body.includes(item.licenseText.trimEnd())
        || !section.body.includes("Source: " + item.licenseSourceUrl)
        || !section.body.includes("License SHA-256: " + item.licenseTextSha256)) {
      throw new Error("GenOffice generated notice failed exact license-text/source verification: " + item.name);
    }
  }
  // 【T117】excused 条目也必须逐个验：通知里**必须**写着「该版本没发许可证文本」，
  // 而且带上理由与复核日期。少一样就说明它在通知里被当成「有文本」混过去了。
  for (const excused of validation.excusedPackages ?? []) {
    const title = excused.name + " v" + excused.version + " — " + excused.spdx;
    const section = findNoticeSection(text, title);
    if (!section
        || !section.body.includes("NO LICENSE TEXT WAS SHIPPED WITH THIS VERSION.")
        || !section.body.includes(excused.evidence)
        || !section.body.includes("Reviewed: " + excused.disposition.reviewedAt)) {
      throw new Error("GenOffice generated notice does not disclose the missing upstream license text: " + excused.name);
    }
  }
  return text;
}

/**
 * 【T117】electron 的 `LICENSES.chromium.html` 在哪。
 *
 * ## 为什么不能只 `assertWithin(app, …)`
 *
 * `appRequire.resolve()` **返回的已经是解引用后的真实路径**（实测：Node 的模块解析
 * 对符号链接做 realpath）。在 pnpm 布局下它是
 * `<repoRoot>/node_modules/.pnpm/electron@…/node_modules/electron/package.json`，
 * **永远不在 `app` 里** —— 所以「字面上在 app 内」这道检查在 pnpm 下必然失败，
 * 不是「多加一道更保险」，是**根本不可能通过**。
 *
 * ## 白名单的判据是「形状」不是「字符串」
 *
 * 放行两种位置，**都必须是 electron 包本身**：
 *   1. `app` 内（npm / yarn 的扁平布局）；
 *   2. **`<repoRoot>/node_modules` 内**（pnpm 的依赖存储）—— 注意根是
 *      `repoRoot/node_modules` 而**不是** `repoRoot`：后者会连带放行
 *      `genoffice/` / `node-red/` / `open-claude-ui/` 三个 vendor 树。
 *
 * ## 这道检查挡的是什么（以及挡不住什么）
 *
 * 它挡的是「解析/符号链接把路径带到仓库之外」。**它挡不住**「在这个位置放一个
 * `name: "electron"` 的伪造包」—— 但那最多让**许可证文本**来自一个错的包，
 * 不构成代码执行，因为这里读的只是 `dist/LICENSES.chromium.html` 这一个文本文件。
 * 下一行的 `name/version` 校验是第二道，两者合起来才够。
 */
function resolveChromiumLicense(app, repoRoot) {
  const appRequire = createRequire(join(app, "package.json"));
  const electronPackagePath = appRequire.resolve("electron/package.json");
  // resolve 已解引用；再 realpath 一次是纵深防御（resolve 的实现将来可能变）。
  const real = fs.realpathSync.native(electronPackagePath);
  // **顺序有意义**：当 app 位于仓库内时 `<repoRoot>/node_modules` 与 `app` 可能
  // 同时命中，必须把更具体的那个放前面。否则 `find` 总是返回 app，下游拿 root
  // 做的包含性断言会在 pnpm 布局下失败（这条 bug 是测试里那条断言抓到的）。
  const allowedRoots = [];
  if (repoRoot) allowedRoots.push(join(repoRoot, "node_modules"));
  allowedRoots.push(app);
  const root = allowedRoots.find(candidate => isWithin(candidate, real));
  if (!root) {
    throw new Error("GenOffice resource path escapes its approved root: electron resolves to "
      + real + ", which is outside " + allowedRoots.join(" and "));
  }
  const electronPackage = JSON.parse(fs.readFileSync(electronPackagePath, "utf8"));
  if (electronPackage.name !== "electron" || typeof electronPackage.version !== "string") {
    throw new Error("Mcode Electron package metadata is invalid; cannot select its Chromium license file");
  }
  return {
    path: join(dirname(electronPackagePath), "dist", "LICENSES.chromium.html"),
    // 调用点要用它做后续的 assertNativeVendorPath —— 白名单有两个根，
    // 下游不能再写死 app，否则 pnpm 布局下会在第二个断言处失败。
    root,
    electronVersion: electronPackage.version,
  };
}
/**
 * A renderer index with a dangling Vite entry script is not a working vendor
 * editor. Check generated local script/style references before advertising
 * that the original editor ASSETS (not necessarily its Host RPC) are staged.
 */
function assertRendererAssetsReady(renderer, name) {
  const html = fs.readFileSync(join(renderer, "index.html"), "utf8");
  const entryScripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)];
  if (entryScripts.length === 0) throw new Error(`GenOffice ${name} original renderer has no entry script`);
  const references = [...html.matchAll(/\b(?:src|href)=["'](\.\/assets\/[^"']+)["']/gi)];
  for (const [, ref] of references) {
    const target = resolve(renderer, ref);
    assertWithin(renderer, target);
    fileReady(target, `${name} renderer asset ${ref}`);
  }
  for (const [, script] of entryScripts) {
    if (!script.startsWith("./assets/")) {
      throw new Error(`GenOffice ${name} renderer script is not a local vendor asset`);
    }
  }
}

/**
 * Patch 0013 (ACK native tool results in a hosted turn) changes the Docs
 * renderer transport — that half only exists in the *built* `out/` assets,
 * not in Mcode's own main-process bundle. Vendor outputs built before the
 * patch therefore pass every hash check (they are internally consistent)
 * while the shipped Docs page silently lacks the in-turn ACK. Detect the
 * stale build by the compiled marker, and fail closed instead of packaging
 * a renderer that cannot answer `mcode:docs:ai-tool-result`.
 *
 * Marker = the two renderer-visible names the patch introduces
 * (`window.desktop.aiToolResult` and the `toolResultAck` option). Minified
 * bundles preserve property names, so both must appear in the entry assets.
 */
const DOCS_ACK_MARKERS = Object.freeze(["aiToolResult", "toolResultAck"]);
function assertDocsRendererHasAckTransport(renderer) {
  const html = fs.readFileSync(join(renderer, "index.html"), "utf8");
  const entryScripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(([, src]) => src);
  const sources = entryScripts.map((src) => fs.readFileSync(join(renderer, src), "utf8"));
  // Deferred chunks may carry the transport too; scan them as well so a
  // marker that moved into a lazy asset is not a false failure.
  const assets = join(renderer, "assets");
  const chunks = fs.readdirSync(assets).filter(name => name.endsWith(".js"))
    .map(name => fs.readFileSync(join(assets, name), "utf8"));
  const corpus = [...sources, ...chunks].join("\n");
  const missing = DOCS_ACK_MARKERS.filter(marker => !corpus.includes(marker));
  if (missing.length) {
    throw new Error(
      "GenOffice docs renderer predates patch 0013 (missing " + missing.join(", ") +
      "): the vendor out/ build is older than the reviewed source. Rebuild the six " +
      "vendor renderers from the pinned HEAD before packaging; do not stage a stale build.",
    );
  }
}

/**
 * Hash the *entire* vendored renderer tree, not just index.html's script/link.
 * Vite lazy imports, fonts and images may be required at runtime even though
 * no HTML tag references them. Persist a digest of exactly what was staged;
 * afterPack can then refuse truncated or silently modified release assets.
 * No reliance on filesystem enumeration order or path separator.
 */
function hashResourceTree(root, namespace = "mcode.genoffice.resource.tree.v1") {
  const hash = createHash("sha256");
  hash.update(namespace + "\0");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  function visit(dir, subpath = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      // 跳过 `electron-builder` 无条件丢弃的两个文件名。
      //
      // `builder-util@26.15.3` 的 `out/fs.js:68`：
      //     if (name === ".DS_Store" || name === ".gitkeep") return null;
      // **在 filter 之前**，所以 `**/*` 也救不回来 —— 与 `node_modules`
      // 那条（`app-builder-lib/out/util/filter.js`）是同一族「filter 改不了
      // 的硬编码跳过」。
      //
      // 而本函数算出的摘要，**唯一用途**是「暂存时算出、打包后重算比对」
      // （`cliDependenciesSha256` / preload digests / renderer digests）。
      // 把打包器永远拿不走的东西算进去，摘要描述的就是暂存目录，而不是
      // 它本该描述的东西 —— 产物里。2026-10-24 实测：`cli/node_modules` 里
      // 两个 `.gitkeep` 因此让 afterPack 报 `digest mismatch`，
      // 而 1949/1951 个文件其余全部一致。
      //
      // 代价：暂存目录里如果有人往 `.gitkeep` 里塞内容，摘要看不见它。
      // 这两个文件在本仓库零引用（`grep -rn gitkeep apps/desktop/build
      // apps/desktop/src/main` 无命中），且 `fileReady` 已经拒绝零字节的
      // **必需**资源，所以这里的信息损失是可接受的。
      //
      // ⚠️ **本函数只哈希文件，空目录不参与摘要 —— 这是改这里之前就有的性质。**
      // 实测（`.tmp` 探针，四组）：
      //   「目录不存在」/「目录存在但空」/「目录里只有 .gitkeep」 → 三者摘要相同
      //   「目录里有真文件」                                        → 摘要不同
      // 所以「用 `.gitkeep` 承载一个必须存在的空目录骨架」这种常见做法，
      // 在本函数里**是不可见的**：目录整个消失也算通过。
      // GenOffice 当前不受影响（那两个含 `.gitkeep` 的目录在产物里都另有真文件，
      // 见 cssstyle/lib/generated 与 undici/lib/llhttp）；但如果将来 vendors
      // 依赖这么一个空目录，afterPack 不会发现它没了 —— 那时要改成
      // 「目录本身也进摘要」，而不是在这里加回 `.gitkeep`。
      if (entry.name === ".DS_Store" || entry.name === ".gitkeep") continue;
      const rel = subpath ? `${subpath}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`GenOffice renderer has unsafe symlink: ${rel}`);
      if (entry.isDirectory()) { visit(full, rel); continue; }
      if (!entry.isFile()) throw new Error(`GenOffice renderer has unsupported filesystem object: ${rel}`);
      hash.update(rel, "utf8");
      hash.update("\0");
      const fd = fs.openSync(full, "r");
      try {
        const size = fs.fstatSync(fd).size;
        hash.update(String(size));
        hash.update("\0");
        let n, bytes = 0;
        while ((n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
          bytes += n;
          hash.update(chunk.subarray(0, n));
        }
        if (bytes !== size) throw new Error(`GenOffice renderer changed during hash: ${rel}`);
      } finally {
        fs.closeSync(fd);
      }
      hash.update("\0");
    }
  }
  visit(root);
  return hash.digest("hex");
}
function hashRendererTree(root) {
  return hashResourceTree(root, "mcode.genoffice.renderer.tree.v1");
}
function hashFile(file) {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  const fd = fs.openSync(file, "r");
  try {
    let n;
    while ((n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, n));
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

function prepareGenofficeResources({ appDir, repoRoot, include = false, includeEditors = false, requireCompleteLicenseBundle = false, licenseManifestPath }) {
  if (typeof include !== "boolean" || typeof includeEditors !== "boolean" || typeof requireCompleteLicenseBundle !== "boolean") {
    throw new TypeError("include, includeEditors and requireCompleteLicenseBundle must be boolean");
  }
  if (licenseManifestPath !== undefined && (typeof licenseManifestPath !== "string" || !licenseManifestPath)) {
    throw new TypeError("licenseManifestPath must be a non-empty path when provided");
  }
  if (includeEditors && !include) throw new Error("GenOffice editors require the CLI bundle to be included");
  const app = resolve(appDir);
  const repo = resolve(repoRoot);
  const tmp = join(app, ".tmp");
  const destination = join(tmp, "genoffice-release");
  const vendor = join(repo, "genoffice");
  const cli = join(vendor, "packages", "cli", "dist", "genoffice.cjs");
  const nodeModules = join(vendor, "packages", "cli", "dist", "node_modules");
  const pdfium = join(vendor, "node_modules", "@embedpdf", "pdfium");
  const wasm = join(pdfium, "dist", "pdfium.wasm");
  const thirdPartyNotice = join(vendor, "apps", "shell", "build", "THIRD-PARTY-NOTICES.txt");
  const completeLicenseBundle = include && requireCompleteLicenseBundle;
  const productionRepo = resolve(__dirname, "../../..");
  const isTestFixtureRoot = resolve(repo).toLowerCase() !== productionRepo.toLowerCase();
  const sourceLicenseManifest = licenseManifestPath ? resolve(licenseManifestPath) : null;
  if (completeLicenseBundle && !sourceLicenseManifest && !isTestFixtureRoot) {
    throw new Error("GenOffice strict release staging requires the reviewed third-party license source manifest");
  }
  const sourceLicenseRoot = sourceLicenseManifest ? join(dirname(sourceLicenseManifest), "licenses") : null;
  const licenseValidation = completeLicenseBundle && sourceLicenseManifest
    ? validateGenofficeLicenseManifest({
      manifestPath: sourceLicenseManifest, licenseRoot: sourceLicenseRoot,
      vendorRoot: vendor, repoRoot: repo, requireComplete: true,
    })
    : null;
  const completeThirdPartyNoticeText = licenseValidation
    ? buildCompleteThirdPartyNotice(fs.readFileSync(thirdPartyNotice, "utf8"), licenseValidation)
    : null;
  const chromiumLicenseInfo = completeLicenseBundle ? resolveChromiumLicense(app, repo) : null;
  const legacyLicenses = [
    [join(vendor, "LICENSE"), "GenOffice-LICENSE", undefined, "vendor"],
    [join(vendor, "NOTICE"), "GenOffice-NOTICE", undefined, "vendor"],
    [join(pdfium, "LICENSE"), "PDFium-LICENSE", undefined, "vendor"],
    [join(pdfium, "LICENSE.pdfium"), "PDFium-LICENSE.pdfium", undefined, "vendor"],
  ];
  const licenses = completeLicenseBundle ? [
    ...legacyLicenses,
    [thirdPartyNotice, "GenOffice-THIRD-PARTY-NOTICES.txt", completeThirdPartyNoticeText, "vendor"],
    [chromiumLicenseInfo.path, "LICENSES.chromium.html", undefined, "app"],
    ...(licenseValidation ? [
      [sourceLicenseManifest, "GenOffice-THIRD-PARTY-LICENSES.json", undefined, "mcode"],
      ...licenseValidation.items.map(item => [
        item.licensePath, "GenOffice-Third-Party-Licenses/" + item.licenseFile, undefined, "mcode",
      ]),
    ] : []),
  ] : legacyLicenses;
  // Validate the entire input BEFORE touching a previous stage.
  // Vite renderer assets are source-built vendor files; never package an
  // incomplete subset (or a symlink to arbitrary workstation/private files).
  const editors = EDITOR_APPS.map((name) => ({
    name, renderer: join(vendor, "apps", name, "out", "renderer"),
  }));
  const nativePreloads = NATIVE_PRELOAD_KINDS.map(name => ({
    name, preload: join(vendor, "apps", name, "out", "preload"),
  }));
  const sidecarExe = process.platform === "win32" ? "xlsx-sidecar.exe" : "xlsx-sidecar";
  const sidecarBin = join(vendor, "apps", "sheets", "native", "xlsx-engine", "target", "release", sidecarExe);
  if (includeEditors) {
    for (const { name, renderer } of editors) {
      assertNativeVendorPath(vendor, renderer);
      dirReady(renderer, `${name} original renderer`);
      fileReady(join(renderer, "index.html"), `${name} original renderer index`);
      dirReady(join(renderer, "assets"), `${name} original renderer assets`);
      assertVendorTreeSafe(vendor, renderer);
      assertWithin(vendor, fs.realpathSync.native(renderer));
      assertRendererAssetsReady(renderer, name);
    }
    assertDocsRendererHasAckTransport(join(vendor, "apps", "docs", "out", "renderer"));
    for (const { name, preload } of nativePreloads) {
      assertNativeVendorPath(vendor, preload);
      dirReady(preload, `${name} original preload`);
      const entry = join(preload, "index.js");
      assertNativeVendorPath(vendor, entry);
      fileReady(entry, `${name} original preload entry`);
      assertVendorTreeSafe(vendor, preload);
    }
    assertNativeVendorPath(vendor, sidecarBin);
    fileReady(sidecarBin, "Rust xlsx-sidecar (required for native Sheets)");
  }
  if (include) {
    fileReady(cli, "CLI");
    dirReady(nodeModules, "CLI node_modules");
    assertVendorTreeSafe(repo, nodeModules);
    fileReady(wasm, "PDFium WASM");
    if (fs.readFileSync(wasm).subarray(0, 4).toString("hex") !== "0061736d") {
      throw new Error("GenOffice PDFium WASM is not a WASM binary");
    }
    for (const [file, name] of licenses) fileReady(file, name);
    const vendorFiles = [cli, nodeModules, wasm, ...licenses
      .filter(([, , , origin]) => origin === "vendor" || origin === undefined)
      .map(([file]) => file)];
    for (const file of vendorFiles) {
      assertNativeVendorPath(vendor, file);
      // A vendor's symlink/junction must not redirect the build to arbitrary
      // machine-private files outside the known checkout.
      assertWithin(repo, fs.realpathSync.native(file));
    }
    // 白名单有两个根（app / <repoRoot>/node_modules），这里必须用 resolveChromiumLicense
    // 判定通过的那个根；写死 app 会在 pnpm 布局下把刚放行的路径再拒一次。
    //
    // ⚠️ 这条只有**完整暂存**（include + requireCompleteLicenseBundle + vendor 树齐全）
    // 才会执行，t11 套件走不到这里。变异「把这行改成 app」在 t11 上是绿的 ——
    // 不是断言失效，是这条路本套件覆盖不到。别把它当成已被守护。
    if (chromiumLicenseInfo) assertNativeVendorPath(chromiumLicenseInfo.root, chromiumLicenseInfo.path);
    for (const [file, , , origin] of licenses.filter(([, , , origin]) => origin === "mcode")) {
      assertNativeVendorPath(repo, file);
    }
    if (completeLicenseBundle) {
      if (completeThirdPartyNoticeText) assertThirdPartyNoticeTextComplete(completeThirdPartyNoticeText);
      else assertThirdPartyNoticeComplete(thirdPartyNotice);
    }
  }
  fs.mkdirSync(tmp, { recursive: true });
  const temp = fs.mkdtempSync(join(tmp, ".genoffice-stage-"));
  const backup = join(tmp, ".genoffice-old-" + randomUUID());
  let hadOld = false;
  try {
    if (include) {
      fs.mkdirSync(join(temp, "cli"), { recursive: true });
      fs.mkdirSync(join(temp, "wasm"), { recursive: true });
      fs.mkdirSync(join(temp, "licenses"), { recursive: true });
      fs.copyFileSync(cli, join(temp, "cli", "genoffice.cjs"));
      // Node 22 + Windows + 非 ASCII 路径：不带 filter 的 cpSync 会 native 崩
      // （nodejs/node#54476、#63970）。filter 强制走 JS 实现。
      fs.cpSync(nodeModules, join(temp, "cli", "node_modules"), {
        recursive: true, dereference: true, filter: () => true,
      });
      fs.copyFileSync(wasm, join(temp, "wasm", "pdfium.wasm"));
      for (const [file, name, content] of licenses) {
        const target = join(temp, "licenses", name);
        fs.mkdirSync(dirname(target), { recursive: true });
        if (typeof content === "string") fs.writeFileSync(target, content, "utf8");
        else fs.copyFileSync(file, target);
      }
      if (includeEditors) {
        for (const { name, renderer } of editors) {
          const target = join(temp, "apps", name, "out", "renderer");
          fs.cpSync(renderer, target, { recursive: true, dereference: false, filter: () => true });
        }
        for (const { name, preload } of nativePreloads) {
          fs.cpSync(preload, join(temp, "apps", name, "out", "preload"), {
            recursive: true, dereference: false, filter: () => true,
          });
        }
        fs.mkdirSync(join(temp, "native"), { recursive: true });
        fs.copyFileSync(sidecarBin, join(temp, "native", sidecarExe));
      }
    }
    fs.writeFileSync(join(temp, "availability.json"), JSON.stringify({
      format: "mcode.genoffice.resources.v1",
      bundled: include,
      editorsBundled: includeEditors,
      editors: includeEditors ? [...EDITOR_APPS] : [],
      ...(include ? {
        licenseBundleVersion: licenseValidation ? 3 : requireCompleteLicenseBundle ? 2 : 1,
        licenseAssetsSha256: Object.fromEntries(licenses.map(([, name]) => [
          name, hashFile(join(temp, "licenses", name)),
        ])),
        ...(licenseValidation ? {
          licenseSourceManifestSha256: hashFile(join(temp, "licenses", "GenOffice-THIRD-PARTY-LICENSES.json")),
          // 这写的是**清单覆盖的包数**，与 `licenseSourceManifestSha256`
          // 配对 —— 不是「这次验证到几份原文」。
          //
          // 原来写的是 `verifiedCount`，在 T117 之前两者恰好相等（18 = 18）所以没暴露。
          // 四个包改成签字例外之后 verified 恒为 14，`afterPack` 的
          // `verify-genoffice-editors-after-pack.cjs:128` 要它等于
          // `REQUIRED_GENOFFICE_LICENSE_PACKAGES.length`（18），于是打包必红。
          // 14 和 18 都不是随便写的：14 是原文数，18 是包数，这个字段要的是后者。
          licenseSourcePackageCount: REQUIRED_GENOFFICE_LICENSE_PACKAGES.length,
        } : {}),
        ...(completeLicenseBundle && !licenseValidation && isTestFixtureRoot ? { licenseBundleTestFixture: true } : {}),
        ...(chromiumLicenseInfo ? { chromiumLicenseElectronVersion: chromiumLicenseInfo.electronVersion } : {}),
      } : {}),
      ...(include ? {
        cliSha256: hashFile(join(temp, "cli", "genoffice.cjs")),
        cliDependenciesSha256: hashResourceTree(join(temp, "cli", "node_modules"), "mcode.genoffice.cli-dependencies.tree.v1"),
        pdfiumWasmSha256: hashFile(join(temp, "wasm", "pdfium.wasm")),
      } : {}),
      ...(includeEditors ? {
        editorAssetsSha256: Object.fromEntries(editors.map(({ name }) => [
          name, hashRendererTree(join(temp, "apps", name, "out", "renderer")),
        ])),
        editorPreloadSha256: Object.fromEntries(nativePreloads.map(({ name }) => [
          name, hashResourceTree(join(temp, "apps", name, "out", "preload"), "mcode.genoffice.preload.tree.v1"),
        ])),
        nativeSidecar: sidecarExe,
        nativeSidecarSha256: hashFile(join(temp, "native", sidecarExe)),
      } : {}),
    }) + "\n", "utf8");
    if (fs.existsSync(destination)) {
      fs.renameSync(destination, backup);
      hadOld = true;
    }
    try {
      fs.renameSync(temp, destination);
    } catch (err) {
      if (hadOld) fs.renameSync(backup, destination);
      throw err;
    }
    if (hadOld) fs.rmSync(backup, { recursive: true, force: true });
    return { bundled: include, editorsBundled: includeEditors, resourceDirectory: destination };
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    const setting = process.env.MCODE_INCLUDE_GENOFFICE_BUNDLE ?? "";
    if (setting !== "" && setting !== "0" && setting !== "1") {
      throw new Error("MCODE_INCLUDE_GENOFFICE_BUNDLE must be 0 or 1");
    }
    const editorsSetting = process.env.MCODE_INCLUDE_GENOFFICE_EDITORS ?? "";
    if (editorsSetting !== "" && editorsSetting !== "0" && editorsSetting !== "1") {
      throw new Error("MCODE_INCLUDE_GENOFFICE_EDITORS must be 0 or 1");
    }
    const appDir = resolve(__dirname, "..");
    const result = prepareGenofficeResources({
      appDir, repoRoot: resolve(appDir, "../.."), include: setting === "1",
      includeEditors: editorsSetting === "1", requireCompleteLicenseBundle: true,
      licenseManifestPath: join(__dirname, "vendor-licenses", "genoffice", "manifest.json"),
    });
    console.log(`GenOffice release sidecar: ${result.bundled ? "CLI staged" : "not included"}; original editors: ${result.editorsBundled ? "six staged" : "not included"}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
module.exports = {
  prepareGenofficeResources, assertWithin, isWithin, assertVendorTreeSafe, assertRendererAssetsReady,
  assertDocsRendererHasAckTransport, hashResourceTree, hashRendererTree, hashFile,
  noticePackagesWithoutLicenseText, assertThirdPartyNoticeComplete, assertThirdPartyNoticeTextComplete,
  assertThirdPartyNoticeMatchesManifest, resolveChromiumLicense, validateGenofficeLicenseManifest,
  buildCompleteThirdPartyNotice, REQUIRED_GENOFFICE_LICENSE_PACKAGES, EDITOR_APPS, NATIVE_PRELOAD_KINDS,
  DOCS_ACK_MARKERS, GENOFFICE_LICENSE_MANIFEST_SHA256, GENOFFICE_LICENSE_MANIFEST_FORMAT,
  GENOFFICE_LICENSE_SOURCE_KINDS, missingLicenseElements, noticeSections, findNoticeSection,
};
