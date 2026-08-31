import { BusyButton } from "./fields";
import { isCustom, modelById, providerById, type BoxState } from "./api";

export function Hero({
  state,
  busy,
  onOfficial,
  onResume,
}: {
  state: BoxState;
  busy: boolean;
  onOfficial: () => void;
  onResume: (modelId: string) => void;
}) {
  const custom = isCustom(state);
  const active = modelById(state, state.activeModelId);
  const provider = active ? providerById(state, active.providerId) : undefined;
  const saved = Boolean(state.providers.length);

  if (!custom) {
    return (
      <section className="hero-card" aria-labelledby="hero-heading">
        <p className="kicker">Chatting with</p>
        <h2 id="hero-heading" className="now-title">
          Official Grok
        </h2>
        <p className="now-body">
          {saved
            ? "Grok Bot is on the stock model. Your providers stay saved — pick one below to come back."
            : "Grok Bot is on the stock model until you connect a provider."}
        </p>
        {saved && active ? (
          <div className="now-actions">
            <BusyButton
              type="button"
              className="button-secondary"
              busy={busy}
              busyLabel="Switching…"
              onClick={() => onResume(active.id)}
            >
              Use {active.slug}
            </BusyButton>
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section className="hero-card" aria-labelledby="hero-heading">
      <p className="kicker">Chatting with</p>
      <h2 id="hero-heading" className="now-title mono">
        {active?.slug || "Your model"}
      </h2>
      <p className="now-body">
        {provider
          ? `${provider.name}. Send a new message in Grok Bot.`
          : "Send a new message in Grok Bot."}
      </p>
      {provider?.origin ? <p className="code">{provider.origin}</p> : null}
      <div className="now-actions">
        <BusyButton
          type="button"
          className="button-secondary"
          busy={busy}
          busyLabel="Switching…"
          onClick={onOfficial}
        >
          Use official Grok
        </BusyButton>
      </div>
    </section>
  );
}
