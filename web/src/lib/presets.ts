/** Curated provider presets for setup and add-provider flows. */

export type FreeModel = { id: string; name: string };

/** Catalog provider id for the curated OpenCode Zen preset. */
export const OPENCODE_ZEN_PROVIDER_ID = "opencode";

/** $0 models listed by models.dev/providers/opencode. Ordered as display order. */
export const OPENCODE_ZEN_FREE_MODELS: readonly FreeModel[] = [
  { id: "big-pickle", name: "big-pickle" },
  { id: "glm-5-free", name: "GLM 5 Free" },
  { id: "glm-4.7-free", name: "GLM 4.7 Free" },
  { id: "deepseek-v4-flash-free", name: "DeepSeek V4 Flash Free" },
  { id: "kimi-k2.5-free", name: "Kimi K2.5 Free" },
  { id: "hy3-free", name: "HY3 Free" },
  { id: "hy3-preview-free", name: "HY3 Preview Free" },
  { id: "grok-code", name: "Grok Code" },
];

export type Preset = {
  id: string;
  name: string;
  origin: string;
  model: string;
  hint: string;
  oauth?: boolean;
};

export const PRESETS: readonly Preset[] = [
  {
    id: "openai",
    name: "OpenAI",
    origin: "https://api.openai.com/v1",
    model: "gpt-4.1",
    hint: "Use an API key or sign in with OpenAI. Credentials stay in local secrets storage.",
    oauth: true,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    origin: "https://openrouter.ai/api/v1",
    model: "openrouter:auto",
    hint: "One API key, many providers. OpenRouter receives the standard referer and title headers.",
  },
  {
    id: "opencode",
    name: "OpenCode Zen",
    origin: "https://opencode.ai/zen/v1",
    model: "big-pickle",
    hint: "Sign up once at opencode.ai, paste your Zen API key, and the $0 models work out of the box.",
  },
  {
    id: "custom",
    name: "Custom",
    origin: "",
    model: "",
    hint: "Any OpenAI-compatible base URL. Type the origin and model id yourself.",
  },
];
