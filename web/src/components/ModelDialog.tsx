import { useEffect, useMemo, useState } from "react";
import { CircleAlert, Plus, Pencil } from "lucide-react";
import {
  DEFAULT_REASONING_LEVELS,
  MODALITIES,
  REASONING_LEVELS,
  type Model,
  type Modality,
  type ReasoningLevel,
} from "../api/types";
import { Button, ParamChip } from "./ui";
import { Field, Input, NumberInput } from "./fields";
import { Modal } from "./overlays";

const MAX_TOKENS = 10_000_000;

type ModelDialogProps = {
  open: boolean;
  onClose: () => void;
  providerName: string;
  existing?: Model | null;
  busy?: boolean;
  onSave: (slug: string, limits: {
    contextTokens: number;
    maxOutputTokens: number;
    reasoningLevels: ReasoningLevel[];
    modalities: Modality[];
    activeReasoning: ReasoningLevel;
  }) => Promise<void>;
};

function defaultsFor(existing?: Model | null) {
  if (existing) {
    return {
      slug: existing.slug,
      context: existing.contextTokens,
      output: existing.maxOutputTokens,
      reasoning: new Set<ReasoningLevel>(existing.reasoningLevels),
      modalities: new Set<Modality>(existing.modalities),
    };
  }
  return {
    slug: "",
    context: 128000,
    output: 65536,
    reasoning: new Set<ReasoningLevel>(DEFAULT_REASONING_LEVELS as readonly ReasoningLevel[]),
    modalities: new Set<Modality>(["text"]),
  };
}

export function ModelDialog({ open, onClose, providerName, existing, busy, onSave }: ModelDialogProps) {
  const [slug, setSlug] = useState("");
  const [context, setContext] = useState<number | null>(128000);
  const [output, setOutput] = useState<number | null>(65536);
  const [reasoning, setReasoning] = useState<Set<ReasoningLevel>>(new Set());
  const [modalities, setModalities] = useState<Set<Modality>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      const d = defaultsFor(existing);
      setSlug(d.slug);
      setContext(d.context);
      setOutput(d.output);
      setReasoning(d.reasoning);
      setModalities(d.modalities);
      setError(null);
    }
  }, [open, existing]);

  const title = existing ? "Edit model" : "Add model";

  const toggleReasoning = (level: ReasoningLevel) => {
    if (level === "default") return;
    setReasoning((prev) => {
      const next = new Set(prev);
      if (next.has(level)) {
        if (next.size > 1) next.delete(level);
      } else {
        next.add(level);
      }
      next.add("default");
      return next;
    });
  };

  const toggleModality = (m: Modality) => {
    setModalities((prev) => {
      const next = new Set(prev);
      if (next.has(m)) {
        if (next.size > 1) next.delete(m);
      } else {
        next.add(m);
      }
      return next;
    });
  };

  const orderedReasoning = useMemo(
    () => REASONING_LEVELS.filter((l) => reasoning.has(l)),
    [reasoning],
  );

  const submit = async () => {
    const trimmed = slug.trim();
    if (!trimmed) {
      setError("Model id is required.");
      return;
    }
    if (context === null || context <= 0 || !Number.isInteger(context) || context > MAX_TOKENS) {
      setError("Context tokens must be a positive integer ≤ 10,000,000.");
      return;
    }
    if (output === null || output <= 0 || !Number.isInteger(output) || output > MAX_TOKENS) {
      setError("Max output tokens must be a positive integer ≤ 10,000,000.");
      return;
    }
    setError(null);
    await onSave(trimmed, {
      contextTokens: context,
      maxOutputTokens: output,
      reasoningLevels: orderedReasoning,
      modalities: MODALITIES.filter((m) => modalities.has(m)),
      activeReasoning: "default",
    });
  };

  return (
    <Modal open={open} onClose={onClose} labelledBy="md-title">
      <div className="dialog dialog--wide">
        <div className="dialog__head">
          <span className="dialog__icon dialog__icon--accent">
            {existing ? <Pencil aria-hidden="true" /> : <Plus aria-hidden="true" />}
          </span>
          <div>
            <div className="dialog__title" id="md-title">
              {title}
            </div>
            <div className="dialog__desc">
              {providerName} · limits are enforced by the hop as ceilings.
            </div>
          </div>
        </div>
        <div className="dialog__body stack" style={{ gap: 12 }}>
          <Field label="Model id / slug" htmlFor="md-slug">
            <Input id="md-slug" mono value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="glm-5.3" />
          </Field>
          <div className="row gap-2" style={{ alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <Field label="Context tokens" htmlFor="md-ctx" helper="Cap 10,000,000">
                <NumberInput id="md-ctx" value={context} onChange={setContext} min={1} max={MAX_TOKENS} className="input--mono" />
              </Field>
            </div>
            <div style={{ flex: 1 }}>
              <Field label="Max output tokens" htmlFor="md-out">
                <NumberInput id="md-out" value={output} onChange={setOutput} min={1} max={MAX_TOKENS} className="input--mono" />
              </Field>
            </div>
          </div>
          <Field label="Reasoning allow-list" helper="default is always kept.">
            <div className="row gap-1 wrap">
              {REASONING_LEVELS.map((l) => (
                <ParamChip
                  key={l}
                  active={reasoning.has(l)}
                  pinned={l === "default"}
                  onClick={() => toggleReasoning(l)}
                >
                  {l}
                </ParamChip>
              ))}
            </div>
          </Field>
          <Field label={<><span>Modalities</span><span style={{ color: "var(--muted)", fontWeight: 400 }}>— metadata only, chat sends text today</span></>}>
            <div className="row gap-2 wrap">
              {MODALITIES.map((m) => (
                <label className="switch" key={m}>
                  <input
                    type="checkbox"
                    checked={modalities.has(m)}
                    onChange={() => toggleModality(m)}
                  />
                  <span className="switch__track"><span className="switch__thumb" /></span>
                  <span className="switch__label">{m}</span>
                </label>
              ))}
            </div>
          </Field>
          {error ? (
            <div className="notice notice--danger">
              <CircleAlert aria-hidden="true" />
              <span className="text">{error}</span>
            </div>
          ) : null}
        </div>
        <div className="dialog__foot">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            Save model
          </Button>
        </div>
      </div>
    </Modal>
  );
}
