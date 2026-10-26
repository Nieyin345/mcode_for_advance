"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function git(repoRoot, args) {
  return execFileSync("git", args, {
    cwd: repoRoot, encoding: "utf8", windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"], timeout: 20_000,
  }).replace(/\r?\n$/, "");
}
function inspectMcodeSource({ repoRoot, releaseVersion } = {}) {
  const root = path.resolve(repoRoot);
  const packagePath = path.join(root, "apps", "desktop", "package.json");
  const current = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const expectedVersion = releaseVersion ?? process.env.MCODE_RELEASE_VERSION ?? current.version;
  const status = git(root, ["status", "--porcelain", "--untracked-files=all"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  if (current.version !== expectedVersion) {
    return { head, releaseVersion: current.version, clean: false, versionOverrideOnly: false, status,
      reason: "package.json version does not match the requested release version" };
  }
  if (!status) {
    return { head, releaseVersion: current.version, clean: true, versionOverrideOnly: false, status: "" };
  }
  // The release workflow intentionally stamps the tag into package.json before
  // building. Permit exactly that single semantic change, and only when its
  // value is independently bound to latest.yml / MCODE_RELEASE_VERSION.
  const lines = status.split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1 || lines[0].slice(0, 2) !== " M"
      || lines[0].slice(3).replace(/^"|"$/g, "") !== "apps/desktop/package.json") {
    return { head, releaseVersion: current.version, clean: false, versionOverrideOnly: false, status,
      reason: "working tree has changes outside the release version stamp" };
  }
  if (!releaseVersion && !process.env.MCODE_RELEASE_VERSION) {
    return { head, releaseVersion: current.version, clean: false, versionOverrideOnly: false, status,
      reason: "release version override is not explicitly declared" };
  }
  try {
    const baseline = JSON.parse(git(root, ["show", "HEAD:apps/desktop/package.json"]));
    if (baseline.version === current.version) {
      return { head, releaseVersion: current.version, clean: false, versionOverrideOnly: false, status,
        reason: "dirty package.json does not represent a version change" };
    }
    const normalized = { ...current, version: baseline.version };
    if (JSON.stringify(normalized) !== JSON.stringify(baseline)) {
      return { head, releaseVersion: current.version, clean: false, versionOverrideOnly: false, status,
        reason: "package.json contains changes beyond the release version stamp" };
    }
  } catch (error) {
    return { head, releaseVersion: current.version, clean: false, versionOverrideOnly: false, status,
      reason: "cannot compare release package metadata to HEAD: " + String(error) };
  }
  return { head, releaseVersion: current.version, clean: true, versionOverrideOnly: true, status };
}
module.exports = { inspectMcodeSource };
