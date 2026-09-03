import { useEffect, useState } from "react";
import { getGrokSkills, installGrokSkills } from "../api/client";
import type { GrokSkill, GrokSkillsReport } from "../api/types";
import { useApp } from "../store";
import { ConfirmDialog } from "./overlays";
import { Badge, Button } from "./ui";

const SOURCE_UNAVAILABLE = "Could not load skills from the OpenBot repo.";
const BLOCKED_REMEDY = "Cannot write Grok Bot user skills. Check folder permissions on the workflows directory.";

function SkillActions({
  skill,
  busy,
  hideInstalledBadge,
  onInstall,
  onUpdate,
}: {
  skill: GrokSkill;
  busy: boolean;
  hideInstalledBadge?: boolean;
  onInstall: (slug: string) => void;
  onUpdate: (slug: string) => void;
}) {
  if (skill.state === "current") {
    return (
      <div className="stack" style={{ gap: 8 }}>
        {hideInstalledBadge ? null : <Badge tone="success">Installed</Badge>}
        <span className="origin-line">{skill.destPath}</span>
      </div>
    );
  }
  if (skill.state === "unavailable") {
    return (
      <p style={{ color: "var(--muted)", margin: 0, fontSize: 13 }}>
        {SOURCE_UNAVAILABLE}
      </p>
    );
  }
  if (skill.state === "blocked") {
    return (
      <p style={{ color: "var(--muted)", margin: 0, fontSize: 13 }}>
        {BLOCKED_REMEDY}
      </p>
    );
  }
  if (skill.state === "missing") {
    return (
      <div className="stack" style={{ gap: 8 }}>
        <p style={{ color: "var(--muted)", margin: 0, fontSize: 13 }}>
          Installs into Grok Bot user skills so Grok Bot can configure OpenBot.
        </p>
        <div>
          <Button variant="secondary" loading={busy} loadingLabel="Installing…" onClick={() => onInstall(skill.slug)}>
            Install from the OpenBot repo
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div>
      <Button variant="secondary" loading={busy} loadingLabel="Installing…" onClick={() => onUpdate(skill.slug)}>
        Update from the OpenBot repo
      </Button>
    </div>
  );
}

export function GrokSkillCard() {
  const { pushToast } = useApp();
  const [report, setReport] = useState<GrokSkillsReport | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmSlug, setConfirmSlug] = useState<string | null>(null);

  const load = async () => {
    try {
      const next = await getGrokSkills();
      setReport(next);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : SOURCE_UNAVAILABLE);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const runInstall = async (slug: string | undefined, kind: "install" | "update") => {
    setBusy(true);
    setConfirmSlug(null);
    try {
      const next = await installGrokSkills(slug);
      setReport(next);
      pushToast(
        "success",
        kind === "update" ? "Skill updated" : "Skill installed",
        "Grok Bot can use this skill on the next turn.",
      );
    } catch (err) {
      pushToast("error", kind === "update" ? "Update failed" : "Install failed", err instanceof Error ? err.message : "Request failed");
      void load();
    } finally {
      setBusy(false);
    }
  };

  const skills = report?.skills ?? [];
  const singleCurrent = skills.length === 1 && skills[0]?.state === "current";

  return (
    <>
      <section className="card col-12" aria-labelledby="h-grok-skill">
        <div className="card__head">
          <span className="card__label" id="h-grok-skill">
            Grok Bot skill
          </span>
          {singleCurrent ? <Badge tone="success">Installed</Badge> : null}
        </div>
        <div className="card__body stack" style={{ gap: 12 }}>
          <p style={{ color: "var(--body)", margin: 0 }}>
            Installs the OpenBot config skill into Grok Bot’s user skills (workflows), not plugins.
          </p>
          {!report && !loadError ? (
            <p style={{ color: "var(--muted)", margin: 0, fontSize: 13 }}>Checking…</p>
          ) : null}
          {loadError || (report && report.source === "none" && skills.length === 0) ? (
            <p style={{ color: "var(--muted)", margin: 0, fontSize: 13 }}>{SOURCE_UNAVAILABLE}</p>
          ) : null}
          {skills.map((skill) => (
            <div key={skill.slug} className="stack" style={{ gap: 8 }}>
              {skills.length > 1 ? (
                <div className="row row--between wrap">
                  <span style={{ fontWeight: 600 }}>{skill.name}</span>
                  {skill.state === "current" ? <Badge tone="success">Installed</Badge> : null}
                </div>
              ) : null}
              <SkillActions
                skill={skill}
                busy={busy}
                hideInstalledBadge={singleCurrent || skills.length > 1}
                onInstall={(slug) => void runInstall(slug, "install")}
                onUpdate={(slug) => setConfirmSlug(slug)}
              />
            </div>
          ))}
        </div>
      </section>

      <ConfirmDialog
        open={confirmSlug !== null}
        onClose={() => setConfirmSlug(null)}
        onConfirm={() => {
          if (confirmSlug) void runInstall(confirmSlug, "update");
        }}
        title="Update from the OpenBot repo?"
        description="This overwrites SKILL.md and reference.md from the OpenBot repo. Extra files in that folder are left alone."
        confirmLabel="Update from the OpenBot repo"
        destructive
        busy={busy}
      />
    </>
  );
}
