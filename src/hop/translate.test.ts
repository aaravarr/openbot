import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultMaxTokens,
  mapFinishReason,
  mapToolCalls,
  messageContentText,
  unwrapJsonSchemaTools,
} from "./translate.ts";
import { HIGH_AGENT_MAX_TOKENS } from "../domain/types.ts";

test("unwrapJsonSchemaTools peels AI SDK jsonSchema so properties are visible", () => {
  const tools = unwrapJsonSchemaTools([
    {
      name: "SendToUser",
      description: "talk to the user",
      parameters: {
        jsonSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
      },
    },
  ]);
  assert.equal(tools.length, 1);
  const parameters = tools[0]?.function.parameters;
  assert.equal(parameters?.properties.message !== undefined, true);
  assert.equal("jsonSchema" in (parameters ?? {}), false);
});

test("unwrapJsonSchemaTools closes every nested object schema for gpt models", () => {
  const schema = {
    type: "object",
    properties: {
      widget: {
        type: "object",
        properties: {
          options: {
            type: "array",
            items: [{ type: "object", properties: { label: { type: "string" } } }],
          },
        },
      },
      choice: {
        anyOf: [
          { type: "object", properties: { value: { type: "string" } } },
          { $ref: "#/$defs/choice" },
        ],
      },
    },
    patternProperties: {
      "^x-": { type: "object", properties: { value: { type: "number" } } },
    },
    $defs: {
      choice: { type: "object", properties: { name: { type: "string" } } },
    },
  };
  const tools = unwrapJsonSchemaTools([{ name: "SendToUser", parameters: schema }], "fusionrouter/GpT-5.6-luna");
  const parameters = tools[0]?.function.parameters as any;
  assert.equal(parameters.additionalProperties, false);
  assert.equal(Object.keys(parameters.properties).at(-1), "additionalProperties");
  assert.equal(parameters.properties.additionalProperties, false);
  assert.equal(parameters.properties.widget.additionalProperties, false);
  assert.equal(Object.keys(parameters.properties.widget.properties).at(-1), "additionalProperties");
  assert.equal(parameters.properties.widget.properties.additionalProperties, false);
  assert.equal(parameters.properties.widget.properties.options.items[0]?.additionalProperties, false);
  assert.equal(Object.keys(parameters.properties.widget.properties.options.items[0].properties).at(-1), "additionalProperties");
  assert.equal(parameters.properties.widget.properties.options.items[0].properties.additionalProperties, false);
  assert.equal(parameters.properties.choice.anyOf[0]?.additionalProperties, false);
  assert.equal(Object.keys(parameters.properties.choice.anyOf[0].properties).at(-1), "additionalProperties");
  assert.equal(parameters.properties.choice.anyOf[0].properties.additionalProperties, false);
  assert.equal(parameters.$defs.choice.additionalProperties, false);
  assert.equal(Object.keys(parameters.$defs.choice.properties).at(-1), "additionalProperties");
  assert.equal(parameters.$defs.choice.properties.additionalProperties, false);
  assert.equal(parameters.patternProperties["^x-"].additionalProperties, false);
  assert.equal(Object.keys(parameters.patternProperties["^x-"].properties).at(-1), "additionalProperties");
  assert.equal(parameters.patternProperties["^x-"].properties.additionalProperties, false);
  assert.equal((schema as any).additionalProperties, undefined);
  assert.equal((schema.properties.widget as any).additionalProperties, undefined);
});

test("unwrapJsonSchemaTools does not add a property key to empty object properties", () => {
  const schema = { type: "object", properties: { empty: { type: "object", properties: {} } } };
  const parameters = unwrapJsonSchemaTools([{ name: "tool", parameters: schema }], "gpt-5.6-luna")[0]?.function.parameters as any;
  assert.equal(parameters.additionalProperties, false);
  assert.equal(parameters.properties.additionalProperties, false);
  assert.equal(parameters.properties.empty.additionalProperties, false);
  assert.deepEqual(parameters.properties.empty.properties, {});
});

test("unwrapJsonSchemaTools leaves non-gpt models and the original schema unchanged", () => {
  const models = ["muse-spark-1.3-contributor", "glm-5.3-flash", "deepseek-v4-pro"];
  for (const modelId of models) {
    const schema = { type: "object", properties: { nested: { type: "object", properties: {} } } };
    const tools = unwrapJsonSchemaTools([{ name: "tool", parameters: schema }], modelId);
    assert.equal((tools[0]?.function.parameters as any).additionalProperties, undefined);
    assert.equal((schema as any).additionalProperties, undefined);
    assert.equal((schema.properties.nested as any).additionalProperties, undefined);
  }
});

test("mapToolCalls keeps a second SendToUser; the generic hop does not drop it", () => {
  const parts = mapToolCalls([
    { id: "c1", function: { name: "SendToUser", arguments: "{\"message\":\"one\"}" } },
    { id: "c2", function: { name: "SendToUser", arguments: "{\"message\":\"two\"}" } },
  ]);
  assert.equal(parts.length, 2);
  assert.equal(parts[0]?.toolName, "SendToUser");
  assert.equal(parts[1]?.toolName, "SendToUser");
  assert.equal(parts[1]?.args.message, "two");
});

test("mapFinishReason maps tool_calls to host tool-calls and honors stop", () => {
  assert.equal(mapFinishReason("tool_calls"), "tool-calls");
  assert.equal(mapFinishReason("stop"), "stop");
  assert.equal(mapFinishReason("length"), "length");
});

test("mapFinishReason keeps the host in the tool loop when tool_calls arrive with stop", () => {
  assert.equal(mapFinishReason("stop", 1), "tool-calls");
  assert.equal(mapFinishReason(undefined, 2), "tool-calls");
  assert.equal(mapFinishReason("length", 1), "length");
});

test("messageContentText joins OpenAI text parts", () => {
  assert.equal(messageContentText("plain"), "plain");
  assert.equal(messageContentText([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "ab");
  assert.equal(messageContentText(null), "");
});

test("default max tokens is 65536, not 8192", () => {
  assert.equal(defaultMaxTokens(undefined), HIGH_AGENT_MAX_TOKENS);
  assert.equal(defaultMaxTokens(undefined), 65536);
  assert.notEqual(defaultMaxTokens(undefined), 8192);
});

test("default max tokens caps at the model max output", () => {
  assert.equal(defaultMaxTokens(undefined, 4096), 4096);
  assert.equal(defaultMaxTokens(99999, 4096), 4096);
  assert.equal(defaultMaxTokens(1024, 4096), 1024);
});
