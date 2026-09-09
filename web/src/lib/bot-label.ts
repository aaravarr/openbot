export type BotLabelRecord = { botId?: string; botName?: string };

/** Resolve a log's display name against the current bot catalog. */
export function botDisplayName(record: BotLabelRecord, botNames: ReadonlyMap<string, string>): string | undefined {
  const botId = record.botId?.trim();
  if (botId) return botNames.get(botId)?.trim() || botId;
  return record.botName?.trim() || undefined;
}
