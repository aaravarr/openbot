/** Curated provider presets for setup and add-provider flows. */

export type Preset = {
  id: string;
  name: string;
  origin: string;
  model: string;
  hint: string;
  requiresSecret: boolean;
  oauth?: boolean;
};

export const PRESETS: readonly Preset[] = [
  {
    id: "opencode",
    name: "OpenCode (Free)",
    origin: "https://opencode.ai/zen/go/v1",
    model: "muse-spark-1.3-contributor",
    hint: "No key required. OpenCode supplies free models through its Go endpoint.",
    requiresSecret: false,
  },
  {
    id: "openai",
    name: "OpenAI",
    origin: "https://api.openai.com/v1",
    model: "gpt-4.1",
    hint: "Use an API key or sign in with OpenAI. Credentials stay in local secrets storage.",
    requiresSecret: true,
    oauth: true,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    origin: "https://openrouter.ai/api/v1",
    model: "openrouter:auto",
    hint: "One API key, many providers. OpenRouter receives the standard referer and title headers.",
    requiresSecret: true,
  },
  {
    id: "custom",
    name: "Custom",
    origin: "",
    model: "",
    hint: "Any OpenAI-compatible base URL. Type the origin and model id yourself.",
    requiresSecret: true,
  },
];
