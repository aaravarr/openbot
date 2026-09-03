/**
 * Install OpenBot Grok Bot skills into the user's editable workflows directory.
 *
 * Destination is Grok Bot user skills only:
 *   /home/box/agent-data/workflows/<slug>/
 * Never write Cursor managed-skills or plugin skill dirs.
 *
 * Source: GitHub Contents API for repo skills/, then local repoRoot/skills/.
 * GET status does not create directories.
 */
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const DEFAULT_AGENT_DATA = "/home/box/agent-data";
export const GROK_SKILLS_GITHUB_REPO = "aaravarr/openbot";
export const GROK_SKILLS_CONTENTS_PATH = "skills";
export const GITHUB_TIMEOUT_MS = 10_000;
export const SOURCE_UNAVAILABLE_MESSAGE = "Could not load skills from the OpenBot repo.";
export const BLOCKED_REMEDY =
  "Cannot write Grok Bot user skills. Check folder permissions on the workflows directory.";

const GITHUB_API = `https://api.github.com/repos/${GROK_SKILLS_GITHUB_REPO}/contents`;

/** Minimal fetch surface so tests can mock GitHub. */
export type FetchLike = (
  url: string,
  init?: { readonly headers?: Record<string, string>; readonly signal?: AbortSignal },
) => Promise<{ readonly status: number; readonly ok: boolean; text(): Promise<string> }>;

export const defaultFetch: FetchLike = (url, init) => fetch(url, init);

export type GrokSkillState = "missing" | "stale" | "current" | "unavailable" | "blocked";

export type GrokSkillRow = {
  readonly slug: string;
  readonly name: string;
  readonly state: GrokSkillState;
  readonly destPath: string;
};

export type GrokSkillsReport = {
  readonly dest: string;
  readonly source: "github" | "local" | "none";
  readonly ref?: string;
  readonly skills: readonly GrokSkillRow[];
};

export type GrokSkillsOptions = {
  readonly repoRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchFn?: FetchLike;
  readonly timeoutMs?: number;
};

export type GrokSkillsInstallResult =
  | { readonly ok: true; readonly status: 200; readonly report: GrokSkillsReport }
  | {
      readonly ok: false;
      readonly status: 400 | 403 | 503;
      readonly error: string;
      readonly report: GrokSkillsReport;
    };

export type SkillFile = {
  readonly relativePath: string;
  readonly bytes: Buffer;
};

export type SourceSkill = {
  readonly slug: string;
  readonly name: string;
  readonly files: readonly SkillFile[];
};

export function grokAgentDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const workflows = env.OPENBOT_WORKFLOWS?.trim();
  if (workflows) {
    return path.dirname(path.resolve(workflows));
  }
  const agentData = env.OPENBOT_AGENT_DATA?.trim();
  return path.resolve(agentData && agentData.length > 0 ? agentData : DEFAULT_AGENT_DATA);
}

export function grokWorkflowsDir(env: NodeJS.ProcessEnv = process.env): string {
  const workflows = env.OPENBOT_WORKFLOWS?.trim();
  if (workflows) {
    return path.resolve(workflows);
  }
  return path.join(grokAgentDataDir(env), "workflows");
}

export function isSkillSlug(raw: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(raw);
}

export function isForbiddenSkillsDest(dest: string): boolean {
  const parts = path.resolve(dest).replaceAll("\\", "/").split("/");
  return parts.includes("managed-skills") || parts.includes("plugins");
}

export function hashSkillFiles(files: readonly SkillFile[]): string {
  const sorted = [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const hash = createHash("sha256");
  for (const file of sorted) {
    hash.update(file.relativePath);
    hash.update("\n");
    hash.update(file.bytes);
  }
  return hash.digest("hex");
}

export function resolveSkillsRef(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.OPENBOT_COMMIT?.trim();
  if (fromEnv && fromEnv !== "unknown") {
    return fromEnv;
  }
  try {
    const raw = readFileSync(path.join(repoRoot, "payload", "version.json"), "utf8");
    const row: unknown = JSON.parse(raw);
    if (row && typeof row === "object" && "commit" in row) {
      const commit = (row as { commit?: unknown }).commit;
      if (typeof commit === "string" && commit.trim() && commit.trim() !== "unknown") {
        return commit.trim();
      }
    }
  } catch {
    /* missing stamp is fine */
  }
  return "main";
}

export function nameFromSkillMd(bytes: Buffer, fallback: string): string {
  const text = bytes.toString("utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (frontmatter?.[1]) {
    const line = /^name:\s*(.+)$/m.exec(frontmatter[1]);
    const raw = line?.[1]?.trim().replace(/^["']|["']$/g, "");
    if (raw) {
      return raw;
    }
  }
  const heading = /^#\s+(.+)$/m.exec(text);
  if (heading?.[1]?.trim()) {
    return heading[1].trim();
  }
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    return String((err as { code: unknown }).code);
  }
  return "";
}

function githubHeaders(): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "openbot",
  };
}

async function githubJson(url: string, fetchFn: FetchLike, signal: AbortSignal): Promise<unknown> {
  const res = await fetchFn(url, { headers: githubHeaders(), signal });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`github ${String(res.status)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("github invalid json");
  }
}

function decodeGithubFile(body: Record<string, unknown>): Buffer | undefined {
  if (body.encoding === "base64" && typeof body.content === "string") {
    return Buffer.from(body.content.replace(/\s+/g, ""), "base64");
  }
  return undefined;
}

async function loadGithubFileBytes(
  entry: Record<string, unknown>,
  fetchFn: FetchLike,
  signal: AbortSignal,
): Promise<Buffer> {
  if (typeof entry.url === "string" && entry.url.length > 0) {
    const body = await githubJson(entry.url, fetchFn, signal);
    if (isRecord(body)) {
      const decoded = decodeGithubFile(body);
      if (decoded !== undefined) {
        return decoded;
      }
    }
  }
  if (typeof entry.download_url === "string" && entry.download_url.length > 0) {
    const res = await fetchFn(entry.download_url, { signal });
    if (!res.ok) {
      throw new Error(`github download ${String(res.status)}`);
    }
    return Buffer.from(await res.text(), "utf8");
  }
  throw new Error("github file has no content");
}

async function loadGithubDirFiles(
  url: string,
  prefix: string,
  fetchFn: FetchLike,
  signal: AbortSignal,
): Promise<SkillFile[]> {
  const listing = await githubJson(url, fetchFn, signal);
  if (!Array.isArray(listing)) {
    throw new Error("github listing is not an array");
  }
  const out: SkillFile[] = [];
  for (const raw of listing) {
    if (!isRecord(raw) || typeof raw.name !== "string" || typeof raw.type !== "string") {
      continue;
    }
    const name = raw.name;
    if (!name || name === "." || name === ".." || name.includes("\0")) {
      continue;
    }
    const rel = prefix ? `${prefix}/${name}` : name;
    if (rel.split("/").includes("..")) {
      continue;
    }
    if (raw.type === "dir") {
      if (typeof raw.url !== "string" || raw.url.length === 0) {
        continue;
      }
      out.push(...(await loadGithubDirFiles(raw.url, rel, fetchFn, signal)));
      continue;
    }
    if (raw.type !== "file") {
      continue;
    }
    out.push({ relativePath: rel, bytes: await loadGithubFileBytes(raw, fetchFn, signal) });
  }
  return out;
}

async function loadGithubSkills(ref: string, fetchFn: FetchLike, signal: AbortSignal): Promise<SourceSkill[]> {
  const rootUrl = `${GITHUB_API}/${GROK_SKILLS_CONTENTS_PATH}?ref=${encodeURIComponent(ref)}`;
  const root = await githubJson(rootUrl, fetchFn, signal);
  if (!Array.isArray(root)) {
    throw new Error("github skills listing is not an array");
  }
  const skills: SourceSkill[] = [];
  for (const raw of root) {
    if (!isRecord(raw) || raw.type !== "dir" || typeof raw.name !== "string") {
      continue;
    }
    const slug = raw.name;
    if (!isSkillSlug(slug)) {
      continue;
    }
    const dirUrl =
      typeof raw.url === "string" && raw.url.length > 0
        ? raw.url
        : `${GITHUB_API}/${GROK_SKILLS_CONTENTS_PATH}/${encodeURIComponent(slug)}?ref=${encodeURIComponent(ref)}`;
    const files = await loadGithubDirFiles(dirUrl, "", fetchFn, signal);
    if (!files.some((file) => file.relativePath === "SKILL.md")) {
      continue;
    }
    const skillMd = files.find((file) => file.relativePath === "SKILL.md");
    skills.push({
      slug,
      name: skillMd ? nameFromSkillMd(skillMd.bytes, slug) : slug,
      files: [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    });
  }
  return skills.sort((a, b) => a.slug.localeCompare(b.slug));
}

async function tryGithubSkills(
  ref: string,
  fetchFn: FetchLike,
  timeoutMs: number,
): Promise<SourceSkill[] | undefined> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await loadGithubSkills(ref, fetchFn, ac.signal);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function walkSkillFiles(root: string): SkillFile[] {
  const out: SkillFile[] = [];
  const walk = (dir: string, relPrefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!ent.name || ent.name === "." || ent.name === ".." || ent.name.includes("\0")) {
        continue;
      }
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      if (rel.split("/").includes("..")) {
        continue;
      }
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        continue;
      }
      if (ent.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (ent.isFile()) {
        out.push({ relativePath: rel, bytes: readFileSync(full) });
      }
    }
  };
  walk(root, "");
  return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function loadLocalSkills(repoRoot: string): SourceSkill[] | undefined {
  const skillsDir = path.join(repoRoot, GROK_SKILLS_CONTENTS_PATH);
  try {
    if (!existsSync(skillsDir) || !statSync(skillsDir).isDirectory()) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  const skills: SourceSkill[] = [];
  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || !isSkillSlug(ent.name)) {
      continue;
    }
    const files = walkSkillFiles(path.join(skillsDir, ent.name));
    if (!files.some((file) => file.relativePath === "SKILL.md")) {
      continue;
    }
    const skillMd = files.find((file) => file.relativePath === "SKILL.md");
    skills.push({
      slug: ent.name,
      name: skillMd ? nameFromSkillMd(skillMd.bytes, ent.name) : ent.name,
      files,
    });
  }
  return skills.sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function loadSkillSource(opts: GrokSkillsOptions): Promise<{
  source: "github" | "local" | "none";
  ref: string;
  skills: readonly SourceSkill[];
}> {
  const env = opts.env ?? process.env;
  const ref = resolveSkillsRef(opts.repoRoot, env);
  const fetchFn = opts.fetchFn ?? defaultFetch;
  const timeoutMs = opts.timeoutMs ?? GITHUB_TIMEOUT_MS;
  const github = await tryGithubSkills(ref, fetchFn, timeoutMs);
  if (github !== undefined) {
    return { source: "github", ref, skills: github };
  }
  const local = loadLocalSkills(opts.repoRoot);
  if (local !== undefined && local.length > 0) {
    return { source: "local", ref, skills: local };
  }
  return { source: "none", ref, skills: [] };
}

export type DestWriteState = { writable: true } | { writable: false; reason: string };

export function destWriteState(workflows: string): DestWriteState {
  if (isForbiddenSkillsDest(workflows)) {
    return {
      writable: false,
      reason: "OpenBot only installs into Grok Bot user skills (workflows), not managed or plugin skills.",
    };
  }
  try {
    let cursor = workflows;
    while (!existsSync(cursor)) {
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        return { writable: false, reason: BLOCKED_REMEDY };
      }
      cursor = parent;
    }
    const st = statSync(cursor);
    if (!st.isDirectory()) {
      return { writable: false, reason: BLOCKED_REMEDY };
    }
    accessSync(cursor, constants.W_OK | constants.X_OK);
    return { writable: true };
  } catch (err) {
    const code = errCode(err);
    if (code === "EACCES" || code === "EPERM") {
      return { writable: false, reason: BLOCKED_REMEDY };
    }
    return { writable: false, reason: BLOCKED_REMEDY };
  }
}

function listInstalledSlugs(workflows: string): string[] {
  try {
    if (!existsSync(workflows) || !statSync(workflows).isDirectory()) {
      return [];
    }
    return readdirSync(workflows, { withFileTypes: true })
      .filter((ent) => ent.isDirectory() && isSkillSlug(ent.name))
      .filter((ent) => {
        const skillMd = path.join(workflows, ent.name, "SKILL.md");
        try {
          return existsSync(skillMd) && statSync(skillMd).isFile();
        } catch {
          return false;
        }
      })
      .map((ent) => ent.name)
      .sort();
  } catch {
    return [];
  }
}

function installedFilesForSource(destDir: string, sourceFiles: readonly SkillFile[]): SkillFile[] {
  const installed: SkillFile[] = [];
  for (const file of sourceFiles) {
    const parts = file.relativePath.split("/").filter((part) => part && part !== "." && part !== "..");
    const target = path.join(destDir, ...parts);
    try {
      if (existsSync(target) && statSync(target).isFile()) {
        installed.push({ relativePath: file.relativePath, bytes: readFileSync(target) });
      }
    } catch {
      /* skip unreadable source-path files */
    }
  }
  return installed;
}

function compareSkill(skill: SourceSkill, destDir: string, writable: boolean): GrokSkillState {
  const skillMd = path.join(destDir, "SKILL.md");
  let missing = true;
  try {
    missing = !existsSync(skillMd) || !statSync(skillMd).isFile();
  } catch {
    missing = true;
  }
  if (missing) {
    return writable ? "missing" : "blocked";
  }
  const current = hashSkillFiles(skill.files) === hashSkillFiles(installedFilesForSource(destDir, skill.files));
  if (current) {
    return "current";
  }
  return writable ? "stale" : "blocked";
}

function reportFromSource(
  dest: string,
  loaded: { source: "github" | "local" | "none"; ref: string; skills: readonly SourceSkill[] },
  writable: boolean,
): GrokSkillsReport {
  const skills: GrokSkillRow[] = [];
  if (loaded.source === "none") {
    for (const slug of listInstalledSlugs(dest)) {
      const destPath = path.join(dest, slug);
      let name = slug;
      try {
        const bytes = readFileSync(path.join(destPath, "SKILL.md"));
        name = nameFromSkillMd(bytes, slug);
      } catch {
        /* keep slug */
      }
      skills.push({ slug, name, state: "unavailable", destPath });
    }
  } else {
    for (const skill of loaded.skills) {
      const destPath = path.join(dest, skill.slug);
      skills.push({
        slug: skill.slug,
        name: skill.name,
        state: compareSkill(skill, destPath, writable),
        destPath,
      });
    }
  }
  return { dest, source: loaded.source, ref: loaded.ref, skills };
}

export async function grokSkillsStatus(opts: GrokSkillsOptions): Promise<GrokSkillsReport> {
  const env = opts.env ?? process.env;
  const dest = grokWorkflowsDir(env);
  const loaded = await loadSkillSource(opts);
  const write = destWriteState(dest);
  return reportFromSource(dest, loaded, write.writable);
}

function writeSkill(workflows: string, skill: SourceSkill): void {
  const dest = path.join(workflows, skill.slug);
  if (isForbiddenSkillsDest(workflows) || isForbiddenSkillsDest(dest)) {
    const err = new Error("refusing to write Cursor managed or plugin skill dirs") as NodeJS.ErrnoException;
    err.code = "EACCES";
    throw err;
  }
  mkdirSync(dest, { recursive: true });
  for (const file of skill.files) {
    const parts = file.relativePath.split("/").filter((part) => part && part !== "." && part !== "..");
    const target = path.join(dest, ...parts);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.bytes);
  }
}

export async function installGrokSkills(
  opts: GrokSkillsOptions & { readonly slug?: string },
): Promise<GrokSkillsInstallResult> {
  const env = opts.env ?? process.env;
  const dest = grokWorkflowsDir(env);
  const loaded = await loadSkillSource(opts);
  const write = destWriteState(dest);
  const report = (): GrokSkillsReport => reportFromSource(dest, loaded, write.writable);

  if (loaded.source === "none" || loaded.skills.length === 0) {
    return { ok: false, status: 503, error: SOURCE_UNAVAILABLE_MESSAGE, report: report() };
  }

  let targets = loaded.skills;
  if (opts.slug !== undefined) {
    if (!isSkillSlug(opts.slug)) {
      return { ok: false, status: 400, error: "invalid slug", report: report() };
    }
    const found = loaded.skills.find((skill) => skill.slug === opts.slug);
    if (found === undefined) {
      return { ok: false, status: 400, error: "unknown skill", report: report() };
    }
    targets = [found];
  }

  if (!write.writable) {
    return { ok: false, status: 403, error: write.reason, report: report() };
  }

  try {
    mkdirSync(dest, { recursive: true });
    for (const skill of targets) {
      writeSkill(dest, skill);
    }
  } catch (err) {
    const code = errCode(err);
    if (code === "EACCES" || code === "EPERM") {
      return { ok: false, status: 403, error: BLOCKED_REMEDY, report: report() };
    }
    throw err;
  }

  return { ok: true, status: 200, report: reportFromSource(dest, loaded, true) };
}
