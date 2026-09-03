import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BLOCKED_REMEDY,
  SOURCE_UNAVAILABLE_MESSAGE,
  destWriteState,
  grokSkillsStatus,
  grokWorkflowsDir,
  hashSkillFiles,
  installGrokSkills,
  isForbiddenSkillsDest,
  isSkillSlug,
  loadLocalSkills,
  nameFromSkillMd,
  resolveSkillsRef,
  type FetchLike,
  type SkillFile,
} from "./grok-skills.ts";

type GhNode = { readonly type: "dir" | "file"; readonly content?: string };

function jsonResponse(status: number, body: unknown): { status: number; ok: boolean; text(): Promise<string> } {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) };
}

function textResponse(status: number, text: string): { status: number; ok: boolean; text(): Promise<string> } {
  return { status, ok: status >= 200 && status < 300, text: async () => text };
}

function githubTree(files: Record<string, string>): Record<string, GhNode> {
  const tree: Record<string, GhNode> = { skills: { type: "dir" } };
  for (const [rel, content] of Object.entries(files)) {
    const full = `skills/${rel}`;
    tree[full] = { type: "file", content };
    const parts = full.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      const dir = parts.slice(0, i).join("/");
      tree[dir] ??= { type: "dir" };
    }
  }
  return tree;
}

function mockGithub(tree: Record<string, GhNode>, expectedRef?: string): FetchLike & { urls: string[] } {
  const urls: string[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    urls.push(url);
    if (init?.headers?.Authorization) {
      throw new Error("must not send a GitHub token");
    }
    const parsed = new URL(url);
    if (parsed.hostname !== "api.github.com") {
      return textResponse(404, "not github");
    }
    if (expectedRef !== undefined && parsed.searchParams.get("ref") !== expectedRef && !url.includes(`ref=${expectedRef}`)) {
      /* file urls from listing include ?ref= */
    }
    const prefix = `/repos/aaravarr/openbot/contents/`;
    if (!parsed.pathname.startsWith(prefix)) {
      return textResponse(404, "not found");
    }
    const filePath = decodeURIComponent(parsed.pathname.slice(prefix.length));
    const node = tree[filePath];
    if (!node) {
      return textResponse(404, "not found");
    }
    const ref = parsed.searchParams.get("ref") ?? "main";
    if (node.type === "file") {
      return jsonResponse(200, {
        type: "file",
        encoding: "base64",
        content: Buffer.from(node.content ?? "", "utf8").toString("base64"),
      });
    }
    const children: unknown[] = [];
    const prefixDir = `${filePath}/`;
    const seen = new Set<string>();
    for (const key of Object.keys(tree)) {
      if (!key.startsWith(prefixDir)) {
        continue;
      }
      const rest = key.slice(prefixDir.length);
      const name = rest.split("/")[0];
      if (!name || seen.has(name)) {
        continue;
      }
      seen.add(name);
      const childPath = `${filePath}/${name}`;
      const child = tree[childPath];
      if (!child) {
        continue;
      }
      children.push({
        name,
        path: childPath,
        type: child.type,
        url: `https://api.github.com/repos/aaravarr/openbot/contents/${childPath}?ref=${encodeURIComponent(ref)}`,
      });
    }
    return jsonResponse(200, children);
  };
  return Object.assign(fetchFn, { urls });
}

function failingFetch(status = 500): FetchLike {
  return async () => textResponse(status, "nope");
}

function hungFetch(): FetchLike {
  return async (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new Error("aborted"));
      });
    });
}

function tmpDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeLocalSkill(repoRoot: string, slug: string, files: Record<string, string>): void {
  const root = path.join(repoRoot, "skills", slug);
  mkdirSync(root, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const dest = path.join(root, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, body);
  }
}

const SAMPLE_SKILL = `---
name: openbot-config
description: test
---

# OpenBot config
`;
const SAMPLE_REF = "# reference\n";

test("isSkillSlug accepts folder names and rejects traversal", () => {
  assert.equal(isSkillSlug("openbot-config"), true);
  assert.equal(isSkillSlug(".."), false);
  assert.equal(isSkillSlug("a/b"), false);
  assert.equal(isSkillSlug(""), false);
});

test("isForbiddenSkillsDest rejects managed-skills and plugins", () => {
  assert.equal(isForbiddenSkillsDest("/home/box/agent-data/workflows"), false);
  assert.equal(isForbiddenSkillsDest("/home/box/agent-data/managed-skills/skills"), true);
  assert.equal(isForbiddenSkillsDest("/home/box/agent-data/plugins/cache/x/skills"), true);
});

test("hashSkillFiles is SHA-256 of relativePath + newline + bytes, sorted", () => {
  const files: SkillFile[] = [
    { relativePath: "b.md", bytes: Buffer.from("B") },
    { relativePath: "a.md", bytes: Buffer.from("A") },
  ];
  const expected = createHash("sha256");
  expected.update("a.md");
  expected.update("\n");
  expected.update("A");
  expected.update("b.md");
  expected.update("\n");
  expected.update("B");
  assert.equal(hashSkillFiles(files), expected.digest("hex"));
});

test("nameFromSkillMd reads frontmatter name", () => {
  assert.equal(nameFromSkillMd(Buffer.from(SAMPLE_SKILL), "fallback"), "openbot-config");
  assert.equal(nameFromSkillMd(Buffer.from("# Hello\n"), "fallback"), "Hello");
  assert.equal(nameFromSkillMd(Buffer.from("no heading"), "fallback"), "fallback");
});

test("grokWorkflowsDir uses OPENBOT_WORKFLOWS then OPENBOT_AGENT_DATA", () => {
  const workflows = path.join(tmpDir("ob-wf-"), "workflows");
  assert.equal(grokWorkflowsDir({ OPENBOT_WORKFLOWS: workflows }), workflows);
  const agent = tmpDir("ob-ad-");
  assert.equal(grokWorkflowsDir({ OPENBOT_AGENT_DATA: agent }), path.join(agent, "workflows"));
  assert.equal(grokWorkflowsDir({}), "/home/box/agent-data/workflows");
});

test("resolveSkillsRef prefers OPENBOT_COMMIT, then payload/version.json, else main", () => {
  const repo = tmpDir("ob-ref-");
  assert.equal(resolveSkillsRef(repo, { OPENBOT_COMMIT: "cafed00d" }), "cafed00d");
  assert.equal(resolveSkillsRef(repo, { OPENBOT_COMMIT: "unknown" }), "main");
  mkdirSync(path.join(repo, "payload"));
  writeFileSync(path.join(repo, "payload", "version.json"), JSON.stringify({ commit: "abc1234deadbeef" }));
  assert.equal(resolveSkillsRef(repo, {}), "abc1234deadbeef");
  writeFileSync(path.join(repo, "payload", "version.json"), JSON.stringify({ commit: "" }));
  assert.equal(resolveSkillsRef(repo, {}), "main");
});

test("status is missing when SKILL.md is absent", async () => {
  const repo = tmpDir("ob-src-");
  const dest = path.join(tmpDir("ob-dst-"), "workflows");
  writeLocalSkill(repo, "openbot-config", { "SKILL.md": SAMPLE_SKILL, "reference.md": SAMPLE_REF });
  const report = await grokSkillsStatus({
    repoRoot: repo,
    env: { OPENBOT_WORKFLOWS: dest },
    fetchFn: failingFetch(),
  });
  assert.equal(report.source, "local");
  assert.equal(report.dest, dest);
  assert.equal(report.skills.length, 1);
  assert.equal(report.skills[0]?.slug, "openbot-config");
  assert.equal(report.skills[0]?.state, "missing");
  assert.equal(existsSync(dest), false);
});

test("GET status does not create the workflows directory", async () => {
  const repo = tmpDir("ob-src-");
  const parent = tmpDir("ob-dst-");
  const dest = path.join(parent, "workflows");
  writeLocalSkill(repo, "openbot-config", { "SKILL.md": SAMPLE_SKILL });
  await grokSkillsStatus({
    repoRoot: repo,
    env: { OPENBOT_WORKFLOWS: dest },
    fetchFn: failingFetch(),
  });
  assert.equal(existsSync(dest), false);
});

test("status is current when hashes match and extra user files are ignored", async () => {
  const repo = tmpDir("ob-src-");
  const dest = path.join(tmpDir("ob-dst-"), "workflows");
  writeLocalSkill(repo, "openbot-config", { "SKILL.md": SAMPLE_SKILL, "reference.md": SAMPLE_REF });
  mkdirSync(path.join(dest, "openbot-config"), { recursive: true });
  writeFileSync(path.join(dest, "openbot-config", "SKILL.md"), SAMPLE_SKILL);
  writeFileSync(path.join(dest, "openbot-config", "reference.md"), SAMPLE_REF);
  writeFileSync(path.join(dest, "openbot-config", "notes.md"), "user extra");
  const report = await grokSkillsStatus({
    repoRoot: repo,
    env: { OPENBOT_WORKFLOWS: dest },
    fetchFn: failingFetch(),
  });
  assert.equal(report.skills[0]?.state, "current");
});

test("status is stale when SKILL.md differs or a source file is missing", async () => {
  const repo = tmpDir("ob-src-");
  const dest = path.join(tmpDir("ob-dst-"), "workflows");
  writeLocalSkill(repo, "openbot-config", { "SKILL.md": SAMPLE_SKILL, "reference.md": SAMPLE_REF });
  mkdirSync(path.join(dest, "openbot-config"), { recursive: true });
  writeFileSync(path.join(dest, "openbot-config", "SKILL.md"), SAMPLE_SKILL + "changed\n");
  writeFileSync(path.join(dest, "openbot-config", "reference.md"), SAMPLE_REF);
  const stale = await grokSkillsStatus({
    repoRoot: repo,
    env: { OPENBOT_WORKFLOWS: dest },
    fetchFn: failingFetch(),
  });
  assert.equal(stale.skills[0]?.state, "stale");

  writeFileSync(path.join(dest, "openbot-config", "SKILL.md"), SAMPLE_SKILL);
  writeFileSync(path.join(dest, "openbot-config", "reference.md"), SAMPLE_REF);
  unlinkSync(path.join(dest, "openbot-config", "reference.md"));
  const missingFile = await grokSkillsStatus({
    repoRoot: repo,
    env: { OPENBOT_WORKFLOWS: dest },
    fetchFn: failingFetch(),
  });
  assert.equal(missingFile.skills[0]?.state, "stale");
});

test("github Contents API is preferred and uses OPENBOT_COMMIT as ref", async () => {
  const repo = tmpDir("ob-src-");
  const dest = path.join(tmpDir("ob-dst-"), "workflows");
  writeLocalSkill(repo, "openbot-config", { "SKILL.md": "local only\n" });
  const gh = mockGithub(
    githubTree({
      "openbot-config/SKILL.md": SAMPLE_SKILL,
      "openbot-config/reference.md": SAMPLE_REF,
    }),
    "cafed00d",
  );
  const report = await grokSkillsStatus({
    repoRoot: repo,
    env: { OPENBOT_WORKFLOWS: dest, OPENBOT_COMMIT: "cafed00d" },
    fetchFn: gh,
  });
  assert.equal(report.source, "github");
  assert.equal(report.ref, "cafed00d");
  assert.equal(report.skills[0]?.state, "missing");
  assert.ok(gh.urls.some((url) => url.includes("/contents/skills?ref=cafed00d")));
  assert.ok(gh.urls.every((url) => !url.toLowerCase().includes("authorization")));
});

test("github failure falls back to local skills/", async () => {
  const repo = tmpDir("ob-src-");
  const dest = path.join(tmpDir("ob-dst-"), "workflows");
  writeLocalSkill(repo, "openbot-config", { "SKILL.md": SAMPLE_SKILL });
  const report = await grokSkillsStatus({
    repoRoot: repo,
    env: { OPENBOT_WORKFLOWS: dest },
    fetchFn: failingFetch(403),
  });
  assert.equal(report.source, "local");
  assert.equal(report.skills[0]?.slug, "openbot-config");
});

test("github timeout falls back to local skills/", async () => {
  const repo = tmpDir("ob-src-");
  const dest = path.join(tmpDir("ob-dst-"), "workflows");
  writeLocalSkill(repo, "openbot-config", { "SKILL.md": SAMPLE_SKILL });
  const report = await grokSkillsStatus({
    repoRoot: repo,
    env: { OPENBOT_WORKFLOWS: dest },
    fetchFn: hungFetch(),
    timeoutMs: 30,
  });
  assert.equal(report.source, "local");
});

test("source is none when GitHub fails and local skills/ is missing", async () => {
  const repo = tmpDir("ob-empty-");
  const dest = path.join(tmpDir("ob-dst-"), "workflows");
  const report = await grokSkillsStatus({
    repoRoot: repo,
    env: { OPENBOT_WORKFLOWS: dest },
    fetchFn: failingFetch(),
  });
  assert.equal(report.source, "none");
  assert.equal(report.skills.length, 0);
});

test("source-unavailable lists installed slugs without guessing stale", async () => {
  const repo = tmpDir("ob-empty-");
  const dest = path.join(tmpDir("ob-dst-"), "workflows");
  mkdirSync(path.join(dest, "openbot-config"), { recursive: true });
  writeFileSync(path.join(dest, "openbot-config", "SKILL.md"), "old\n");
  const report = await grokSkillsStatus({
    repoRoot: repo,
    env: { OPENBOT_WORKFLOWS: dest },
    fetchFn: failingFetch(),
  });
  assert.equal(report.source, "none");
  assert.equal(report.skills[0]?.state, "unavailable");
});

test("install writes UTF-8 files and mkdir -p workflows/<slug>", async () => {
  const repo = tmpDir("ob-src-");
  const dest = path.join(tmpDir("ob-dst-"), "workflows");
  writeLocalSkill(repo, "openbot-config", { "SKILL.md": SAMPLE_SKILL, "reference.md": SAMPLE_REF });
  const result = await installGrokSkills({
    repoRoot: repo,
    env: { OPENBOT_WORKFLOWS: dest },
    fetchFn: failingFetch(),
    slug: "openbot-config",
  });
  assert.equal(result.ok, true);
  assert.equal(result.report.skills[0]?.state, "current");
  assert.equal(readFileSync(path.join(dest, "openbot-config", "SKILL.md"), "utf8"), SAMPLE_SKILL);
  assert.equal(readFileSync(path.join(dest, "openbot-config", "reference.md"), "utf8"), SAMPLE_REF);
});

test("install all slugs when slug is omitted", async () => {
  const repo = tmpDir("ob-src-");
  const dest = path.join(tmpDir("ob-dst-"), "workflows");
  writeLocalSkill(repo, "openbot-config", { "SKILL.md": SAMPLE_SKILL });
  writeLocalSkill(repo, "other-skill", { "SKILL.md": "---\nname: other\n---\n# Other\n" });
  const result = await installGrokSkills({
    repoRoot: repo,
    env: { OPENBOT_WORKFLOWS: dest },
    fetchFn: failingFetch(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.report.skills.length, 2);
  assert.equal(existsSync(path.join(dest, "openbot-config", "SKILL.md")), true);
  assert.equal(existsSync(path.join(dest, "other-skill", "SKILL.md")), true);
});

test("update overwrites source files and leaves extra user files", async () => {
  const repo = tmpDir("ob-src-");
  const dest = path.join(tmpDir("ob-dst-"), "workflows");
  writeLocalSkill(repo, "openbot-config", { "SKILL.md": SAMPLE_SKILL, "reference.md": SAMPLE_REF });
  mkdirSync(path.join(dest, "openbot-config"), { recursive: true });
  writeFileSync(path.join(dest, "openbot-config", "SKILL.md"), "old skill\n");
  writeFileSync(path.join(dest, "openbot-config", "reference.md"), "old ref\n");
  writeFileSync(path.join(dest, "openbot-config", "notes.md"), "keep me");
  const result = await installGrokSkills({
    repoRoot: repo,
    env: { OPENBOT_WORKFLOWS: dest },
    fetchFn: failingFetch(),
    slug: "openbot-config",
  });
  assert.equal(result.ok, true);
  assert.equal(result.report.skills[0]?.state, "current");
  assert.equal(readFileSync(path.join(dest, "openbot-config", "SKILL.md"), "utf8"), SAMPLE_SKILL);
  assert.equal(readFileSync(path.join(dest, "openbot-config", "notes.md"), "utf8"), "keep me");
});

test("install refuses unknown slug and source-unavailable", async () => {
  const repo = tmpDir("ob-src-");
  const dest = path.join(tmpDir("ob-dst-"), "workflows");
  writeLocalSkill(repo, "openbot-config", { "SKILL.md": SAMPLE_SKILL });
  const unknown = await installGrokSkills({
    repoRoot: repo,
    env: { OPENBOT_WORKFLOWS: dest },
    fetchFn: failingFetch(),
    slug: "not-a-skill",
  });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) {
    assert.equal(unknown.status, 400);
    assert.equal(unknown.error, "unknown skill");
  }

  const empty = tmpDir("ob-empty-");
  const none = await installGrokSkills({
    repoRoot: empty,
    env: { OPENBOT_WORKFLOWS: dest },
    fetchFn: failingFetch(),
  });
  assert.equal(none.ok, false);
  if (!none.ok) {
    assert.equal(none.status, 503);
    assert.equal(none.error, SOURCE_UNAVAILABLE_MESSAGE);
  }
});

test("blocked dest has no install when workflows parent is not writable", async () => {
  const repo = tmpDir("ob-src-");
  writeLocalSkill(repo, "openbot-config", { "SKILL.md": SAMPLE_SKILL });
  const parent = tmpDir("ob-ro-");
  chmodSync(parent, 0o555);
  const dest = path.join(parent, "workflows");
  try {
    const write = destWriteState(dest);
    assert.equal(write.writable, false);
    const report = await grokSkillsStatus({
      repoRoot: repo,
      env: { OPENBOT_WORKFLOWS: dest },
      fetchFn: failingFetch(),
    });
    assert.equal(report.skills[0]?.state, "blocked");
    const result = await installGrokSkills({
      repoRoot: repo,
      env: { OPENBOT_WORKFLOWS: dest },
      fetchFn: failingFetch(),
      slug: "openbot-config",
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 403);
      assert.equal(result.error, BLOCKED_REMEDY);
    }
    assert.equal(existsSync(dest), false);
  } finally {
    chmodSync(parent, 0o755);
  }
});

test("blocked dest that is already current stays current", async () => {
  const repo = tmpDir("ob-src-");
  const parent = tmpDir("ob-ro-");
  const dest = path.join(parent, "workflows");
  writeLocalSkill(repo, "openbot-config", { "SKILL.md": SAMPLE_SKILL });
  mkdirSync(path.join(dest, "openbot-config"), { recursive: true });
  writeFileSync(path.join(dest, "openbot-config", "SKILL.md"), SAMPLE_SKILL);
  chmodSync(dest, 0o555);
  try {
    const report = await grokSkillsStatus({
      repoRoot: repo,
      env: { OPENBOT_WORKFLOWS: dest },
      fetchFn: failingFetch(),
    });
    assert.equal(report.skills[0]?.state, "current");
  } finally {
    chmodSync(dest, 0o755);
  }
});

test("install does not write managed-skills or plugins paths", async () => {
  const repo = tmpDir("ob-src-");
  writeLocalSkill(repo, "openbot-config", { "SKILL.md": SAMPLE_SKILL });
  const managed = path.join(tmpDir("ob-ms-"), "managed-skills", "skills");
  mkdirSync(managed, { recursive: true });
  const result = await installGrokSkills({
    repoRoot: repo,
    env: { OPENBOT_WORKFLOWS: managed },
    fetchFn: failingFetch(),
    slug: "openbot-config",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 403);
  }
  assert.equal(existsSync(path.join(managed, "openbot-config", "SKILL.md")), false);
});

test("loadLocalSkills skips folders without SKILL.md", () => {
  const repo = tmpDir("ob-src-");
  writeLocalSkill(repo, "openbot-config", { "SKILL.md": SAMPLE_SKILL });
  mkdirSync(path.join(repo, "skills", "empty-dir"), { recursive: true });
  writeFileSync(path.join(repo, "skills", "empty-dir", "readme.txt"), "no");
  const local = loadLocalSkills(repo);
  assert.ok(local);
  assert.deepEqual(
    local.map((row) => row.slug),
    ["openbot-config"],
  );
});

test("github install writes the Contents API bytes", async () => {
  const repo = tmpDir("ob-src-");
  const dest = path.join(tmpDir("ob-dst-"), "workflows");
  const gh = mockGithub(
    githubTree({
      "openbot-config/SKILL.md": SAMPLE_SKILL,
      "openbot-config/reference.md": SAMPLE_REF,
    }),
  );
  const result = await installGrokSkills({
    repoRoot: repo,
    env: { OPENBOT_WORKFLOWS: dest, OPENBOT_COMMIT: "main" },
    fetchFn: gh,
    slug: "openbot-config",
  });
  assert.equal(result.ok, true);
  assert.equal(result.report.source, "github");
  assert.equal(readFileSync(path.join(dest, "openbot-config", "SKILL.md"), "utf8"), SAMPLE_SKILL);
});
