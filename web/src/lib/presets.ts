/** Provider presets for the setup wizard and add-provider flow (FR-8, FR-9). */

export type Preset = {
  id: string;
  name: string;
  origin: string;
  model: string;
  hint: string;
};

export const PRESETS: readonly Preset[] = [
  {
    id: "openai",
    name: "OpenAI",
    origin: "https://api.openai.com/v1",
    model: "gpt-4.1",
    hint: "Create a key at platform.openai.com — billed by OpenAI directly.",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    origin: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    hint: "Create a key at platform.deepseek.com. Reasoning levels map to deepseek's reasoning_effort.",
  },
  {
    id: "zhipu",
    name: "Zhipu GLM",
    origin: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-5.3",
    hint: "Create a key at open.bigmodel.cn. A GLM Coding Plan key works here; thinking levels map to GLM thinking/effort.",
  },
  {
    id: "moonshot",
    name: "Kimi",
    origin: "https://api.moonshot.cn/v1",
    model: "kimi-k3",
    hint: "Create a key at platform.moonshot.cn.",
  },
  {
    id: "qwen",
    name: "Qwen",
    origin: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3-max",
    hint: "Create a key at the Alibaba Cloud Model Studio.",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    origin: "https://openrouter.ai/api/v1",
    model: "openrouter:auto",
    hint: "One key, many providers. Model ids use the openrouter:slug form.",
  },
  {
    id: "groq",
    name: "Groq",
    origin: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    hint: "Create a key at console.groq.com — very fast inference.",
  },
  {
    id: "xai",
    name: "xAI",
    origin: "https://api.x.ai/v1",
    model: "grok-4.5",
    hint: "Create a key at console.x.ai. This routes Grok Bot back through an xAI model.",
  },
  {
    id: "custom",
    name: "Custom",
    origin: "",
    model: "",
    hint: "Any OpenAI-compatible base URL. Type the origin and model id yourself.",
  },
];
