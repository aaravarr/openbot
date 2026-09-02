import type { ReasoningLevel } from "../api/types";

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value <= 0) return "—";
  if (value >= 1000 && value % 1000 === 0) return `${String(value / 1000)}K`;
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/u, "")}K`;
  return String(value);
}

export function formatInteger(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US");
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("en-GB", { hour12: false });
}

export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function labelReasoning(level: string): string {
  if (level === "xhigh") return "Extra high";
  if (level === "default") return "Default";
  if (level === "none") return "Off";
  return level.slice(0, 1).toUpperCase() + level.slice(1);
}

export function labelModality(item: string): string {
  return item.slice(0, 1).toUpperCase() + item.slice(1);
}

export function reasoningListLabel(levels: readonly string[]): string {
  if (!levels.length) return "—";
  return levels.join("·");
}

export function activeReasoningLabel(levels: readonly string[], active: string): string {
  if (levels.includes(active)) return labelReasoning(active);
  return labelReasoning("default");
}

/** Coerce an arbitrary reasoning string into a valid ReasoningLevel, defaulting safely. */
export function coerceReasoning(value: string | undefined, allow: readonly string[]): ReasoningLevel {
  if (value && allow.includes(value)) return value as ReasoningLevel;
  if (allow.includes("default")) return "default";
  return (allow[0] as ReasoningLevel) ?? "default";
}

export function originDisplay(origin: string): string {
  return origin.replace(/^https?:\/\//u, "").replace(/\/$/u, "");
}

export function formatCount(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
