export type ChatContext = {
  botId?: string;
  botName?: string;
  chatType?: "group" | "dm" | "routine";
  chatName?: string;
};

type Message = { role?: unknown; content?: unknown };

export type ChatContextOptions = {
  resolveBotName?: (botId: string) => string | undefined;
};

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).join("\n");
  if (value && typeof value === "object") {
    const part = value as { text?: unknown; content?: unknown };
    if (typeof part.text === "string") return part.text;
    if (part.content !== undefined) return contentText(part.content);
  }
  return "";
}

function extractBotIdentity(messages: readonly Message[]): Pick<ChatContext, "botId" | "botName"> {
  let botId: string | undefined;
  let botName: string | undefined;
  for (const message of messages.slice(0, 5)) {
    const text = contentText(message.content);
    if (!botName) {
      const nameMatch = text.match(/Your agent name is\s*(?:[\"']([^\"'\r\n]{1,200})[\"']|([^\r\n.]{1,200}))/i)
        ?? text.match(/(?:agent|bot)\s+(?:name|title)\s*[:=]\s*(?:[\"']([^\"'\r\n]{1,200})[\"']|([^\r\n.]{1,200}))/i);
      botName = nameMatch?.[1]?.trim() ?? nameMatch?.[2]?.trim() ?? nameMatch?.[3]?.trim() ?? nameMatch?.[4]?.trim();
    }
    if (!botId) botId = text.match(/\/home\/box\/agent-data\/agents\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/profile\.json/i)?.[1];
    if (botName && botId) break;
  }
  return { ...(botId ? { botId } : {}), ...(botName ? { botName } : {}) };
}

export function extractChatContext(messages: readonly Message[] | unknown, options: ChatContextOptions = {}): ChatContext {
  const rows = Array.isArray(messages) ? messages : [];
  const identity = extractBotIdentity(rows as Message[]);
  let latest: ChatContext | undefined;

  for (const message of rows as Message[]) {
    if (message.role !== "user") continue;
    const text = contentText(message.content);
    const queryIndex = text.indexOf("<user_query>");
    if (queryIndex < 0) continue;
    const query = text.slice(queryIndex + "<user_query>".length).trim();
    const group = query.match(/\[Group chat:\s*"([^"\r\n]{1,200})"/);
    if (group) {
      latest = { chatType: "group" };
      if (group[1]) latest.chatName = group[1];
      continue;
    }
    const withoutReminders = query.replace(/<system_reminder>[\s\S]*?<\/system_reminder>/gi, "").trim();
    if (!withoutReminders || /^\[routine\](?:\s|$)/i.test(withoutReminders)) {
      latest = { chatType: "routine" };
      continue;
    }
    latest = { chatType: "dm" };
  }

  if (!identity.botName && identity.botId && options.resolveBotName) {
    const resolved = options.resolveBotName(identity.botId)?.trim();
    if (resolved) identity.botName = resolved;
  }
  return { ...identity, ...(latest ?? {}) };
}
