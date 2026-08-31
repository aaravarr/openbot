export type Preset = {
  id: string;
  name: string;
  origin: string;
  model: string;
  hint: string;
};

export type ProviderDraft = {
  name: string;
  origin: string;
  modelSlug: string;
  secret: string;
};

export const PRESETS: readonly Preset[] = [
  {
    id: "openai",
    name: "OpenAI",
    origin: "https://api.openai.com/v1",
    model: "gpt-4.1",
    hint: "A platform API key. A ChatGPT password will not work.",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    origin: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    hint: "OpenAI-compatible Chat Completions on api.deepseek.com.",
  },
  {
    id: "zhipu",
    name: "Zhipu GLM",
    origin: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4.6",
    hint: "GLM on the Zhipu OpenAI-compatible endpoint.",
  },
  {
    id: "moonshot",
    name: "Kimi",
    origin: "https://api.moonshot.cn/v1",
    model: "kimi-k2-0905-preview",
    hint: "Moonshot OpenAI-compatible API.",
  },
  {
    id: "qwen",
    name: "Qwen",
    origin: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    hint: "DashScope compatible-mode, not the native DashScope protocol.",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    origin: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4.1",
    hint: "One key, many labs. Use the provider/model id OpenRouter shows.",
  },
  {
    id: "groq",
    name: "Groq",
    origin: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    hint: "The Groq OpenAI-compatible URL includes /openai/v1.",
  },
  {
    id: "xai",
    name: "xAI",
    origin: "https://api.x.ai/v1",
    model: "grok-3",
    hint: "An xAI API key, used from this Computer — not from your Mac.",
  },
  {
    id: "custom",
    name: "Custom",
    origin: "",
    model: "",
    hint: "Any HTTPS endpoint that speaks OpenAI Chat Completions.",
  },
];

export function draftFromPreset(preset: Preset): ProviderDraft {
  if (preset.id === "custom") {
    return { name: "", origin: "", modelSlug: "", secret: "" };
  }
  return {
    name: preset.name,
    origin: preset.origin,
    modelSlug: preset.model,
    secret: "",
  };
}
