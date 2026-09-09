import { useEffect, useState } from "react";
import { Bot as BotIcon, Pause, Play } from "lucide-react";
import { getBotModels, getBots, getPauseBots, setBotModel, setPauseBot } from "../api/client";
import type { BotInfo, BotModels } from "../api/types";
import { useApp, useBoxState } from "../store";
import { Badge, EmptyState, Spinner, Switch } from "../components/ui";

export function Bots() {
  const state = useBoxState();
  const { pushToast } = useApp();
  const [bots, setBots] = useState<BotInfo[]>([]);
  const [pausedBotIds, setPausedBotIds] = useState<Set<string>>(() => new Set());
  const [botModels, setBotModels] = useState<BotModels | null>(null);
  const [modelDraft, setModelDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busyBotId, setBusyBotId] = useState<string | null>(null);
  const [modelBusyBotId, setModelBusyBotId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([getBots(), getPauseBots(), getBotModels()])
      .then(([nextBots, pauseState, nextBotModels]) => {
        if (!alive) return;
        setBots(nextBots);
        setPausedBotIds(new Set(pauseState.pausedBotIds));
        setBotModels(nextBotModels);
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
      setBotModels(next);
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
          {loading ? <Spinner /> : <Badge>{bots.length} {bots.length === 1 ? "bot" : "bots"}</Badge>}
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
          <div className="bot-list">
            {bots.map((bot) => {
              const paused = pausedBotIds.has(bot.botId);
              const busy = busyBotId === bot.botId;
              return (
                <div className="bot-row" key={bot.botId}>
                  <span className={"bot-row__icon" + (paused ? " is-paused" : "")} aria-hidden="true">
                    {paused ? <Pause /> : <Play />}
                  </span>
                  <div className="bot-row__main">
                    <strong>{bot.botName}</strong>
                    <span className="mono">{bot.botId}</span>
                  </div>
                  <div className="bot-row__model">
                    <select
                      aria-label={"Model for " + bot.botName}
                      value={modelDraft[bot.botId] ?? ""}
                      disabled={modelBusyBotId === bot.botId || botModels === null}
                      onChange={(e) => void saveModel(bot, e.target.value)}
                    >
                      <option value="">Default (global)</option>
                      {(botModels?.available ?? []).map((id) => (
                        <option value={id} key={id}>
                          {state.models.find((model) => model.id === id)?.slug ?? id}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Switch
                    checked={paused}
                    disabled={busy}
                    label={busy ? "Saving" : paused ? "Paused" : "Active"}
                    onChange={(next) => void toggle(bot, next)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
