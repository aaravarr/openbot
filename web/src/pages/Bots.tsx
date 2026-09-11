import { useEffect, useState } from "react";
import { Bot as BotIcon, Check, Minus } from "lucide-react";
import { getBotModels, getBots, getPauseBots, setBotModel, setBotModels, setPauseBot, setPauseBots } from "../api/client";
import type { BotInfo, BotModels } from "../api/types";
import { useApp, useBoxState } from "../store";
import { Badge, EmptyState, Spinner, Switch } from "../components/ui";
import { Listbox } from "../components/Listbox";
import { modelGroupsForState } from "../lib/model-options";
import { computePauseIds, computeResumeIds } from "../lib/batch-pause";

function formatBotTime(value: number | null): string {
  if (value === null) return "Time unavailable";
  const age = Math.max(0, Date.now() - value);
  if (age < 60 * 60 * 1000) return `Updated ${Math.max(1, Math.round(age / 60000))}m ago`;
  if (age < 24 * 60 * 60 * 1000) return `Updated ${Math.round(age / 3600000)}h ago`;
  return `Updated ${new Date(value).toLocaleDateString()}`;
}

export function Bots() {
  const state = useBoxState();
  const { pushToast } = useApp();
  const [bots, setBots] = useState<BotInfo[]>([]);
  const [pausedBotIds, setPausedBotIds] = useState<Set<string>>(() => new Set());
  const [botModels, setBotModelsState] = useState<BotModels | null>(null);
  const [modelDraft, setModelDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busyBotId, setBusyBotId] = useState<string | null>(null);
  const [modelBusyBotId, setModelBusyBotId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchModel, setBatchModel] = useState("");

  useEffect(() => {
    let alive = true;
    Promise.all([getBots(), getPauseBots(), getBotModels()])
      .then(([nextBots, pauseState, nextBotModels]) => {
        if (!alive) return;
        setBots(nextBots);
        setPausedBotIds(new Set(pauseState.pausedBotIds));
         setBotModelsState(nextBotModels);
        setModelDraft(nextBotModels.assignments);
      })
      .catch(() => {
        if (alive) pushToast("error", "Bots failed to load", "Could not reach the bot pause endpoint.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [pushToast]);

  const toggle = async (bot: BotInfo, paused: boolean) => {
    if (busyBotId) return;
    setBusyBotId(bot.botId);
    const before = pausedBotIds;
    setPausedBotIds((current) => {
      const next = new Set(current);
      if (paused) next.add(bot.botId);
      else next.delete(bot.botId);
      return next;
    });
    try {
      const next = await setPauseBot(bot.botId, paused);
      setPausedBotIds(new Set(next.pausedBotIds));
      pushToast("success", paused ? "Bot paused" : "Bot resumed", bot.botName);
    } catch {
      setPausedBotIds(before);
      pushToast("error", "Pause switch failed", "Could not save this bot's pause state.");
    } finally {
      setBusyBotId(null);
    }
  };

  const saveModel = async (bot: BotInfo, modelId: string) => {
    if (modelBusyBotId) return;
    setModelBusyBotId(bot.botId);
    setModelDraft((current) => ({ ...current, [bot.botId]: modelId }));
    try {
      const next = await setBotModel(bot.botId, modelId || null);
       setBotModelsState(next);
      setModelDraft(next.assignments);
      pushToast(
        "success",
        modelId ? "Bot model saved" : "Bot model cleared",
        modelId ? bot.botName + " uses the selected model on its next message." : bot.botName + " is back on the global model.",
      );
    } catch {
      setModelDraft(botModels?.assignments ?? {});
      pushToast("error", "Bot model save failed", "Could not save this bot's model override.");
    } finally {
      setModelBusyBotId(null);
    }
  };

  const activeBots = bots.filter((bot) => !bot.deleted);
  const selectedActiveIds = activeBots.filter((bot) => selectedIds.has(bot.botId)).map((bot) => bot.botId);
  const allSelected = activeBots.length > 0 && selectedActiveIds.length === activeBots.length;
  const toggleSelected = (botId: string) => setSelectedIds((current) => {
    const next = new Set(current);
    if (next.has(botId)) next.delete(botId); else next.add(botId);
    return next;
  });
  const toggleAll = () => setSelectedIds(allSelected ? new Set() : new Set(activeBots.map((bot) => bot.botId)));

  const runBatch = async (kind: "model" | "pause" | "resume") => {
    if (batchBusy || selectedActiveIds.length === 0) return;
    setBatchBusy(true);
    try {
      if (kind === "model") {
        const next = await setBotModels(selectedActiveIds, batchModel || null);
        setBotModelsState(next);
        setModelDraft(next.assignments);
        pushToast("success", "Models updated", `Updated ${selectedActiveIds.length} bot${selectedActiveIds.length === 1 ? "" : "s"}.`);
      } else {
        // PUT /api/pause-bots replaces the whole list, so compute the new list
        // from the latest server state, not React state — otherwise a pause
        // added by another client between loads would be dropped.
        const latest = await getPauseBots();
        const nextIds = kind === "pause"
          ? computePauseIds(latest.pausedBotIds, selectedActiveIds)
          : computeResumeIds(latest.pausedBotIds, selectedActiveIds);
        const next = await setPauseBots(nextIds);
        setPausedBotIds(new Set(next.pausedBotIds));
        pushToast("success", kind === "pause" ? "Bots paused" : "Bots resumed", `Updated ${selectedActiveIds.length} bot${selectedActiveIds.length === 1 ? "" : "s"}.`);
      }
    } catch (err) {
      pushToast("error", "Batch update failed", err instanceof Error ? err.message : "Some bots could not be updated.");
    } finally {
      setBatchBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="page-title-row">
        <h1>Bots</h1>
        <span className="sub">Pause bots or pin a model per bot. Unassigned bots use the global model.</span>
      </div>

      <section className="card" aria-labelledby="bots-heading">
        <div className="card__head">
          <div className="card__head-main">
            <span className="card__label" id="bots-heading">Bot access</span>
            <p className="card__hint">Paused bots receive a clear 503 response; model overrides apply on the next message.</p>
          </div>
          <div className="row gap-2">
            {!loading && activeBots.length > 0 ? (
              <label className="bot-select-all">
                <input type="checkbox" aria-label="Select all active bots" checked={allSelected} onChange={toggleAll} />
                <span className="checkbox__box">{allSelected ? <Check aria-hidden="true" /> : selectedActiveIds.length > 0 ? <Minus aria-hidden="true" /> : null}</span>
                <span className="label">Select all</span>
              </label>
            ) : null}
            {loading ? <Spinner /> : <Badge>{activeBots.length} {activeBots.length === 1 ? "bot" : "bots"}</Badge>}
          </div>
        </div>

        {loading ? (
          <div className="card__body stack" aria-busy="true">
            <div className="skel skel--row" />
            <div className="skel skel--row" />
            <div className="skel skel--row" />
          </div>
        ) : bots.length === 0 ? (
          <div className="card__body">
            <EmptyState
              icon={BotIcon}
              title="No bots found"
              body="Create a bot profile on the Computer and it will appear here."
            />
          </div>
        ) : (
          <>
          {selectedActiveIds.length > 0 ? (
            <div className="bot-batch-bar bot-batch-bar--grouped" role="region" aria-label="Batch actions" aria-live="polite">
              <span className="bot-batch-count">{selectedActiveIds.length} selected</span>
              <span className="bot-batch-spacer" />
              <span className="bot-batch-group">
                <Listbox label="Set model" groups={modelGroupsForState(state, state.models.filter((model) => botModels?.available.includes(model.id)))} value={batchModel} placeholder="Set model" disabled={batchBusy || botModels === null} onChange={setBatchModel} />
                <button className="btn btn--secondary" type="button" disabled={batchBusy || botModels === null} onClick={() => void runBatch("model")}>{batchBusy ? "Applying..." : "Apply"}</button>
              </span>
              <span className="bot-batch-sep" aria-hidden="true" />
              <span className="bot-batch-group">
                <button className="btn btn--secondary" type="button" disabled={batchBusy} onClick={() => void runBatch("resume")}>Resume</button>
                <button className="btn btn--secondary" type="button" disabled={batchBusy} onClick={() => void runBatch("pause")}>Pause</button>
              </span>
            </div>
          ) : null}
          <div className="bot-list">
            {bots.map((bot) => {
              const paused = pausedBotIds.has(bot.botId);
              const busy = busyBotId === bot.botId;
              return (
                <div className={"bot-row bot-row--dense" + (bot.deleted ? " is-deleted" : "")} key={bot.botId} title={bot.deleted ? "Deleted" : undefined}>
                  <label className="checkbox"><input type="checkbox" aria-label={`Select ${bot.botName}`} checked={selectedIds.has(bot.botId)} disabled={bot.deleted || batchBusy} onChange={() => toggleSelected(bot.botId)} /><span className="checkbox__box">{selectedIds.has(bot.botId) ? <Check aria-hidden="true" /> : null}</span></label>
                  <div className="bot-row__main">
                    <strong>{bot.botName}</strong>
                    <span className="bot-row__id">{bot.botId}</span>
                    <span className="bot-row__time">{bot.deleted ? "Deleted" : formatBotTime(bot.updatedAtMs)}</span>
                  </div>
                  <div className="bot-row__model">
                    <Listbox
                      label={"Model for " + bot.botName}
                       groups={[{ label: "Global", options: [{ value: "", label: "Default" }] }, ...modelGroupsForState(state, state.models.filter((model) => botModels?.available.includes(model.id)))]}
                      value={modelDraft[bot.botId] ?? ""}
                      disabled={bot.deleted || modelBusyBotId === bot.botId || botModels === null}
                      onChange={(id) => void saveModel(bot, id)}
                    />
                  </div>
                  <Switch
                    checked={!paused}
                    disabled={bot.deleted || busy}
                    label={busy ? "Saving" : paused ? "Paused" : "Active"}
                    onChange={(next) => void toggle(bot, !next)}
                  />
                </div>
              );
            })}
          </div>
          </>
        )}
      </section>
    </div>
  );
}
