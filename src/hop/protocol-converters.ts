type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v && typeof v === "object" && !Array.isArray(v));

export type ApiType = "chat-completions" | "responses" | "anthropic";

function clampId(value: unknown): string {
  const raw = typeof value === "string" && value ? value : "call_0";
  return raw.length <= 64 ? raw : `${raw.slice(0, 56)}_${stableHash(raw)}`;
}
function stableHash(value: string): string {
  let h = 2166136261;
  for (const byte of new TextEncoder().encode(value)) h = Math.imul(h ^ byte, 16777619) >>> 0;
  return h.toString(36).padStart(7, "0");
}
function contentToResponses(value: unknown): unknown {
  if (!Array.isArray(value)) return value ?? "";
  return value.map((part) => {
    if (!isObj(part)) return part;
    if (part.type === "text") return { ...part, type: "input_text" };
    if (part.type === "image_url") {
      const image = isObj(part.image_url) ? part.image_url : {};
      return { type: "input_image", image_url: image.url ?? part.url ?? "", detail: image.detail ?? "auto" };
    }
    return part;
  });
}
export function chatToResponses(body: unknown): Obj {
  if (!isObj(body)) return {};
  const out: Obj = {};
  for (const key of ["model", "stream", "temperature", "top_p", "metadata", "store", "user", "parallel_tool_calls", "tool_choice"]) if (body[key] !== undefined) out[key] = body[key];
  out.max_output_tokens = body.max_completion_tokens ?? body.max_tokens;
  if (typeof body.reasoning_effort === "string") out.reasoning = { effort: body.reasoning_effort };
  if (Array.isArray(body.tools)) out.tools = body.tools.map((tool) => isObj(tool) && isObj(tool.function) ? { type: "function", ...tool.function } : tool);
  const input: unknown[] = [];
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!isObj(message)) continue;
    if (message.role === "tool") { input.push({ type: "function_call_output", call_id: clampId(message.tool_call_id), output: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "") }); continue; }
    input.push({ role: message.role, content: contentToResponses(message.content) });
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      if (isObj(call) && isObj(call.function)) input.push({ type: "function_call", call_id: clampId(call.id), name: call.function.name, arguments: call.function.arguments ?? "{}" });
    }
  }
  out.input = input;
  return out;
}
function outputParts(payload: Obj): { text: string; reasoning: string; calls: Obj[] } {
  let text = "", reasoning = ""; const calls: Obj[] = [];
  for (const item of Array.isArray(payload.output) ? payload.output : []) {
    if (!isObj(item)) continue;
    if (item.type === "function_call") calls.push({ id: item.call_id ?? item.id, type: "function", function: { name: item.name, arguments: item.arguments ?? "{}" } });
    if (item.type === "reasoning") for (const part of [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])]) if (isObj(part) && typeof part.text === "string") reasoning += part.text;
    if (item.type === "message") for (const part of Array.isArray(item.content) ? item.content : []) if (isObj(part) && typeof part.text === "string") text += part.text;
  }
  return { text, reasoning, calls };
}
function responsesFinish(payload: Obj): string {
  const output = outputParts(payload); if (output.calls.length) return "tool_calls";
  const details = isObj(payload.incomplete_details) ? payload.incomplete_details : {};
  if (payload.status === "incomplete" || /max_tokens|output_tokens/.test(String(details.reason ?? ""))) return "length";
  if (String(details.reason ?? "") === "content_filter") return "content_filter";
  return "stop";
}
function responsesUsage(usage: unknown): Obj | undefined {
  if (!isObj(usage)) return undefined;
  return { prompt_tokens: Number(usage.input_tokens ?? 0), completion_tokens: Number(usage.output_tokens ?? 0), total_tokens: Number(usage.total_tokens ?? Number(usage.input_tokens ?? 0) + Number(usage.output_tokens ?? 0)), ...(isObj(usage.input_tokens_details) ? { prompt_tokens_details: usage.input_tokens_details } : {}), ...(isObj(usage.output_tokens_details) ? { completion_tokens_details: usage.output_tokens_details } : {}) };
}
export function responsesToChat(payload: unknown): Obj {
  if (!isObj(payload)) return { id: "", object: "chat.completion", choices: [] };
  const out = outputParts(payload);
  return { id: payload.id ?? "", object: "chat.completion", created: payload.created_at ?? Math.floor(Date.now() / 1000), model: payload.model, choices: [{ index: 0, message: { role: "assistant", content: out.text || null, ...(out.reasoning ? { reasoning_content: out.reasoning } : {}), ...(out.calls.length ? { tool_calls: out.calls } : {}) }, finish_reason: responsesFinish(payload) }], ...(responsesUsage(payload.usage) ? { usage: responsesUsage(payload.usage) } : {}) };
}
export function chatToAnthropic(body: unknown): Obj {
  if (!isObj(body)) return {};
  const out: Obj = { model: body.model, max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 65536, stream: body.stream === true };
  if (body.temperature !== undefined) out.temperature = body.temperature; if (body.top_p !== undefined) out.top_p = body.top_p; if (body.stop !== undefined) out.stop_sequences = body.stop;
  const system: string[] = [];
  if (Array.isArray(body.tools)) out.tools = body.tools.map((tool) => isObj(tool) && isObj(tool.function) ? { name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters ?? { type: "object", properties: {} } } : tool);
  const messages: Obj[] = [];
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!isObj(message)) continue;
    if (message.role === "system") {
      if (typeof message.content === "string") system.push(message.content);
      continue;
    }
    if (message.role === "tool") { messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: message.tool_call_id, content: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "") }] }); continue; }
    const blocks: unknown[] = []; const text = typeof message.content === "string" ? message.content : ""; if (text) blocks.push({ type: "text", text });
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) if (isObj(call) && isObj(call.function)) { let input: unknown = {}; try { input = JSON.parse(String(call.function.arguments ?? "{}")); } catch {} blocks.push({ type: "tool_use", id: clampId(call.id), name: call.function.name, input: isObj(input) ? input : {} }); }
    messages.push({ role: message.role === "assistant" ? "assistant" : "user", content: blocks.length === 1 && isObj(blocks[0]) && blocks[0].type === "text" ? text : blocks });
  }
  if (system.length) out.system = system.join("\n\n");
  out.messages = messages; return out;
}
function anthropicUsage(usage: unknown): Obj | undefined {
  if (!isObj(usage)) return undefined;
  const input = Number(usage.input_tokens ?? 0) + Number(usage.cache_read_input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0);
  return { prompt_tokens: input, completion_tokens: Number(usage.output_tokens ?? 0), total_tokens: input + Number(usage.output_tokens ?? 0), ...(Number(usage.cache_read_input_tokens ?? 0) ? { prompt_tokens_details: { cached_tokens: Number(usage.cache_read_input_tokens) } } : {}) };
}
export function anthropicToChat(payload: unknown): Obj {
  if (!isObj(payload)) return { id: "", object: "chat.completion", choices: [] };
  const content: Obj[] = []; for (const part of Array.isArray(payload.content) ? payload.content : []) { if (!isObj(part)) continue; if (part.type === "text" && typeof part.text === "string") content.push({ type: "text", text: part.text }); if (part.type === "thinking") content.push({ type: "thinking", text: typeof part.thinking === "string" ? part.thinking : part.text }); if (part.type === "tool_use") content.push({ type: "tool_call", id: part.id, name: part.name, arguments: JSON.stringify(part.input ?? {}) }); }
  const text = content.filter((p) => p.type === "text").map((p) => p.text).join(""); const reasoning = content.filter((p) => p.type === "thinking").map((p) => p.text).filter((p): p is string => typeof p === "string").join(""); const calls = content.filter((p) => p.type === "tool_call").map((p) => ({ id: p.id, type: "function", function: { name: p.name, arguments: p.arguments } }));
  const finish = payload.stop_reason === "tool_use" ? "tool_calls" : payload.stop_reason === "max_tokens" ? "length" : payload.stop_reason === "refusal" ? "content_filter" : "stop";
  return { id: payload.id ?? "", object: "chat.completion", created: Math.floor(Date.now() / 1000), model: payload.model, choices: [{ index: 0, message: { role: "assistant", content: text || null, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: finish }], ...(anthropicUsage(payload.usage) ? { usage: anthropicUsage(payload.usage) } : {}) };
}
export function mapUpstreamError(payload: unknown, status: number): Obj {
  const root = isObj(payload) ? payload : {}; const error = isObj(root.error) ? root.error : root; const message = typeof error.message === "string" ? error.message : "upstream request failed"; const code = typeof error.code === "string" ? error.code : typeof error.type === "string" ? error.type : "upstream_error"; return { error: { message, type: code, code } };
}
function parseSse(raw: string): Obj[] { const out: Obj[] = []; for (const block of raw.split(/\r?\n\r?\n/)) { const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n"); if (!data || data === "[DONE]") continue; try { const value = JSON.parse(data); if (isObj(value)) out.push(value); } catch {} } return out; }
export function responsesSseToChat(raw: string): string { const chunks: Obj[] = []; let id = "", model: unknown; for (const event of parseSse(raw)) { if (event.type === "response.created" && isObj(event.response)) { id = String(event.response.id ?? id); model = event.response.model ?? model; chunks.push({ id, object: "chat.completion.chunk", created: Math.floor(Date.now()/1000), model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }); } else if (event.type === "response.output_text.delta" || (String(event.type).includes("reasoning") && String(event.type).endsWith(".delta"))) chunks.push({ id, object: "chat.completion.chunk", created: Math.floor(Date.now()/1000), model, choices: [{ index: 0, delta: event.type === "response.output_text.delta" ? { content: event.delta } : { reasoning_content: event.delta }, finish_reason: null }] }); else if (event.type === "response.output_item.added" && isObj(event.item) && event.item.type === "function_call") chunks.push({ id, object: "chat.completion.chunk", created: Math.floor(Date.now()/1000), model, choices: [{ index: 0, delta: { tool_calls: [{ index: Number(event.output_index ?? 0), id: event.item.call_id ?? event.item.id, type: "function", function: { name: event.item.name, arguments: "" } }] }, finish_reason: null }] }); else if (event.type === "response.function_call_arguments.delta") chunks.push({ id, object: "chat.completion.chunk", created: Math.floor(Date.now()/1000), model, choices: [{ index: 0, delta: { tool_calls: [{ index: Number(event.output_index ?? 0), function: { arguments: event.delta } }] }, finish_reason: null }] }); else if (event.type === "response.completed" || event.type === "response.incomplete") chunks.push({ id, object: "chat.completion.chunk", created: Math.floor(Date.now()/1000), model, choices: [{ index: 0, delta: {}, finish_reason: responsesFinish(isObj(event.response) ? event.response : {}) }], ...(isObj(event.response) && responsesUsage(event.response.usage) ? { usage: responsesUsage(event.response.usage) } : {}) }); } return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n"; }
export function anthropicSseToChat(raw: string): string { const chunks: Obj[] = []; let id = "", model: unknown; let finish: unknown = null, usage: unknown; for (const event of parseSse(raw)) { if (event.type === "message_start" && isObj(event.message)) { id = String(event.message.id ?? id); model = event.message.model ?? model; } if (event.type === "content_block_delta" && isObj(event.delta)) { if (event.delta.type === "text_delta") chunks.push({ id, object: "chat.completion.chunk", created: Math.floor(Date.now()/1000), model, choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }] }); if (event.delta.type === "thinking_delta") chunks.push({ id, object: "chat.completion.chunk", created: Math.floor(Date.now()/1000), model, choices: [{ index: 0, delta: { reasoning_content: event.delta.thinking }, finish_reason: null }] }); if (event.delta.type === "input_json_delta") chunks.push({ id, object: "chat.completion.chunk", created: Math.floor(Date.now()/1000), model, choices: [{ index: 0, delta: { tool_calls: [{ index: event.index, function: { arguments: event.delta.partial_json } }] }, finish_reason: null }] }); } if (event.type === "message_delta") { const d = isObj(event.delta) ? event.delta : {}; finish = d.stop_reason; usage = event.usage; } } const reason = finish === "tool_use" ? "tool_calls" : finish === "max_tokens" ? "length" : "stop"; chunks.push({ id, object: "chat.completion.chunk", created: Math.floor(Date.now()/1000), model, choices: [{ index: 0, delta: {}, finish_reason: reason }], ...(anthropicUsage(usage) ? { usage: anthropicUsage(usage) } : {}) }); return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n"; }
