#!/usr/bin/env node
/**
 * release-notes.mjs — compose the GitHub Release body for one tag.
 *
 * The release body used to be a fixed install block, so a release never said
 * what changed. This script turns that into a property of the repository: it
 * copies the tag's `## [<version>]` section out of CHANGELOG.md (see that file
 * for the format) and appends the install block.
 *
 * A missing section does NOT fail the release — an urgent fix must still be
 * publishable — but it falls back to the commit list and says so, in the body
 * and on stderr, so the gap is visible rather than silent.
 *
 * Usage (see .github/workflows/release.yml):
 *   node scripts/release-notes.mjs \
 *     --version v0.1.2 --changelog CHANGELOG.md \
 *     --commits commits.txt --sha <commit> --out release-notes.md
 *
 * `--commits` is a plain-text list prepared by the workflow (`git log`); taking
 * it as a file keeps this script free of git and runnable locally:
 *   node scripts/release-notes.mjs --version 0.1.2 --out - # prints, writes nothing
 */
import { readFileSync, writeFileSync } from "node:fs";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

const version = String(arg("version", "")).trim().replace(/^v/, "");
const changelogPath = arg("changelog", "CHANGELOG.md");
const commitsPath = arg("commits");
const sha = arg("sha", "");
const outPath = arg("out", "release-notes.md");

if (version === "") {
  console.error("release-notes: --version is required");
  process.exit(2);
}

/** Escape a version for use inside a RegExp. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The body of `## [<version>]`, up to the next `## ` heading.
 * @returns the section text, or null when the changelog has no such section.
 */
export function sectionFrom(markdown, wanted) {
  const lines = markdown.split(/\r?\n/);
  const heading = new RegExp(`^##\\s*\\[${escapeRegExp(wanted)}\\]`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return null;
  const body = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index])) break;
    body.push(lines[index]);
  }
  const text = body.join("\n").trim();
  return text === "" ? null : text;
}

function readIfPresent(file) {
  if (file === undefined) return null;
  try {
    const text = readFileSync(file, "utf8").trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

const fromChangelog = (() => {
  const markdown = readIfPresent(changelogPath);
  return markdown === null ? null : sectionFrom(markdown, version);
})();

let changes;
if (fromChangelog !== null) {
  changes = fromChangelog;
} else {
  console.error(`release-notes: no "## [${version}]" section in ${changelogPath}; falling back to the commit list`);
  const commits = readIfPresent(commitsPath);
  changes = commits === null
    ? `> ${changelogPath} 中没有 ${version} 的小节，也没有可用的提交列表。`
    : `> ${changelogPath} 中没有 ${version} 的小节，以下为该标签包含的提交：\n\n${commits}`;
}

const pinned = sha === "" ? "" : `#${sha}`;
const body = [
  "## 更新内容",
  "",
  changes,
  "",
  "## 安装",
  "",
  "```sh",
  "# 从 tarball（本 Release 附件）",
  `dsh plugin --profile web add ./dsh-approval-mode-${version}.tgz`,
  "",
  "# 或从仓库安装（锁定提交以固定内容）",
  `dsh plugin --profile web add github:NEVSTOP-LAB/dsh-approval-mode${pinned}`,
  "```",
  "",
  "`--profile web` 是默认 profile；桌面版用 `--profile desktop`。",
  "详见 [README](https://github.com/NEVSTOP-LAB/dsh-approval-mode#readme)。",
  ""
].join("\n");

if (outPath === "-") {
  process.stdout.write(body);
} else {
  writeFileSync(outPath, body, "utf8");
  console.log(`release-notes: wrote ${outPath} (${fromChangelog !== null ? `CHANGELOG section ${version}` : "commit-list fallback"})`);
}
