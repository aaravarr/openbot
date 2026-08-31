import { HIGH_AGENT_MAX_TOKENS } from "../domain/types.ts";

export type JsonSchema = {
  readonly type: "object";
  readonly properties: Record<string, unknown>;
  readonly required?: readonly string[];
};

export type HostTool = {
  readonly name?: string;
  readonly description?: string;
  readonly parameters?: unknown;
  readonly function?: {
    readonly name?: string;
    readonly description?: string;
    readonly parameters?: unknown;
  };
  readonly type?: string;
};

export type OpenAiFunctionTool = {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: JsonSchema;
  };
};

export type HostToolCallPart = {
  readonly type: "tool-call";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
};

export type FinishReason = "stop" | "tool-calls" | "length";

const EMPTY_SCHEMA: JsonSchema = { type: "object", properties: {} };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asJsonSchema(value: unknown): JsonSchema {
  if (!isRecord(value)) {
    return EMPTY_SCHEMA;
  }
  if (isRecord(value.jsonSchema)) {
    return asJsonSchema(value.jsonSchema);
  }
  const properties = isRecord(value.properties) ? value.properties : {};
  const required = Array.isArray(value.required)
    ? value.required.filter((item): item is string => typeof item === "string")
    : undefined;
  if (required) {
    return { type: "object", properties, required };
  }
  return { type: "object", properties };
}

export function unwrapJsonSchemaTools(tools: readonly HostTool[]): OpenAiFunctionTool[] {
  const out: OpenAiFunctionTool[] = [];
  for (const tool of tools) {
    if (!tool || tool.type === "provider-defined") {
      continue;
    }
    const fn = tool.function ?? tool;
    const name = tool.name ?? fn.name;
    if (!name) {
      continue;
    }
    out.push({
      type: "function",
      function: {
        name,
        description: tool.description ?? fn.description ?? "",
        parameters: asJsonSchema(tool.parameters ?? fn.parameters),
      },
    });
  }
  return out;
}

export function mapToolCalls(openAiCalls: readonly unknown[]): HostToolCallPart[] {
  const out: HostToolCallPart[] = [];
  for (const [index, raw] of openAiCalls.entries()) {
    if (!isRecord(raw)) {
      continue;
    }
    const fn = isRecord(raw.function) ? raw.function : {};
    const name = typeof fn.name === "string" ? fn.name : "";
    let args: Record<string, unknown> = {};
    if (typeof fn.arguments === "string") {
      try {
        const parsed: unknown = JSON.parse(fn.arguments);
        if (isRecord(parsed)) {
          args = parsed;
        }
      } catch {
        args = {};
      }
    } else if (isRecord(fn.arguments)) {
      args = fn.arguments;
    } else if (isRecord(raw.args)) {
      args = raw.args;
    }
    const id = typeof raw.id === "string" ? raw.id : `call_${String(index)}`;
    out.push({ type: "tool-call", toolCallId: id, toolName: name, args });
  }
  return out;
}

export function mapFinishReason(reason: string | undefined): FinishReason {
  if (reason === "tool_calls" || reason === "tool-calls") {
    return "tool-calls";
  }
  if (reason === "length") {
    return "length";
  }
  return "stop";
}

export function defaultMaxTokens(requested: number | undefined, cap: number = HIGH_AGENT_MAX_TOKENS): number {
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : HIGH_AGENT_MAX_TOKENS;
  if (requested != null && Number.isFinite(requested) && requested > 0) {
    return Math.min(Math.floor(requested), limit);
  }
  return limit;
}
