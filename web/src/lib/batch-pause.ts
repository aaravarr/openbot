/**
 * Pure diff/merge helpers for PUT /api/pause-bots, whose `pausedBotIds` body
 * replaces the entire list. Always merge against the latest server state so a
 * batch only touches the bots the user selected.
 */

export function computePauseIds(latestPausedBotIds: readonly string[], selectedBotIds: readonly string[]): string[] {
  return [...new Set([...latestPausedBotIds, ...selectedBotIds])].sort();
}

export function computeResumeIds(latestPausedBotIds: readonly string[], selectedBotIds: readonly string[]): string[] {
  const selected = new Set(selectedBotIds);
  return [...new Set(latestPausedBotIds)].filter((botId) => !selected.has(botId)).sort();
}
