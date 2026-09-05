import { type Expose } from "../domain/types.ts";
import { boxFromSavedMode, customBoxFromCatalog } from "../parse/argv.ts";
import { wrapFromSource, type SupervisorDeps } from "./observe.ts";
import { catalogFromPlanJson } from "./plan.ts";
import { reconcile, type ReconcileOpts, type ReconcileResult } from "./reconcile.ts";
import { readExposeFile } from "./tunnel.ts";

/**
 * The custom guard checks that user-owned custom state is actually live and
 * repairs drift back to custom. The official channel has zero quota, so the
 * guard never writes the official mode token, never reconciles an official
 * desired state, and never removes the wrap. The parent schedules it; there
 * are no timers or daemons here.
 */

export type GuardDetail = "healthy" | "repaired" | "refused" | "no-custom-state";

export type GuardResult = {
  /** The mode file did not say custom and was rewritten to custom. */
  readonly modeRepaired: boolean;
  /** The host file was stock-unmarked and the wrap was reinstalled. */
  readonly wrapRepaired: boolean;
  /** Custom state is live after the guard ran. */
  readonly ok: boolean;
  readonly detail: GuardDetail;
  /** The repair reconcile, or undefined when no repair was needed or possible. */
  readonly reconcile: ReconcileResult | undefined;
};

export type GuardOpts = {
  /** Recorded on every audit line the repair reconcile writes. Default "guard". */
  readonly source?: string;
};

/** The cli reconcile-from-disk path pinned to custom: official on disk with a non-empty catalog is drift. */
function customBoxFromDisk(deps: SupervisorDeps, expose: Expose) {
  const mode = deps.fs.read(deps.paths.mode);
  const catalog = catalogFromPlanJson(deps.fs.read(deps.paths.plan));
  const box = boxFromSavedMode({ paths: deps.paths, mode, catalog, expose });
  if (box.kind === "custom") {
    return box;
  }
  if (catalog.models.length > 0) {
    return customBoxFromCatalog({ paths: deps.paths, catalog, expose });
  }
  return undefined;
}

export async function guardCustom(deps: SupervisorDeps, opts: GuardOpts = {}): Promise<GuardResult> {
  const desired = customBoxFromDisk(deps, readExposeFile(deps.fs, deps.paths.expose));
  if (desired === undefined) {
    return { modeRepaired: false, wrapRepaired: false, ok: false, detail: "no-custom-state", reconcile: undefined };
  }
  const modeDrift = deps.fs.read(deps.paths.mode)?.trim() !== "custom";
  const wrapDrift = wrapFromSource(deps.fs.read(deps.paths.hostMain)).kind === "stock-unmarked";
  if (!modeDrift && !wrapDrift) {
    return { modeRepaired: false, wrapRepaired: false, ok: true, detail: "healthy", reconcile: undefined };
  }
  const repairOpts: ReconcileOpts = { source: opts.source ?? "guard" };
  const result = await reconcile(desired, deps, repairOpts);
  if (result.kind === "refused") {
    return { modeRepaired: false, wrapRepaired: false, ok: false, detail: "refused", reconcile: result };
  }
  return { modeRepaired: modeDrift, wrapRepaired: wrapDrift, ok: true, detail: "repaired", reconcile: result };
}
