import type { ReactNode } from "react";
import type { BoxState, Model } from "../api/types";
import { formatTokens } from "./format";
import { hasKey } from "../api/client";
import type { ListboxGroup } from "../components/Listbox";

export function modelGroupsForState(state: BoxState, models: readonly Model[] = state.models): ListboxGroup[] {
  return state.providers.map((provider) => ({
    label: provider.name,
    options: models
      .filter((model) => model.providerId === provider.id)
      .map((model) => ({
        value: model.id,
        label: model.slug,
        sublabel: hasKey(state, provider.id) ? undefined : "no key",
        badges: modelBadges(model, hasKey(state, provider.id)),
      })),
  }));
}

export function modelBadges(model: Model, keyed: boolean): ReactNode {
  return (
    <>
      {formatTokens(model.contextTokens) !== "—" ? <span className="badge">{formatTokens(model.contextTokens)}</span> : null}
      {!keyed ? <span className="badge badge--warning">No key</span> : null}
    </>
  );
}
