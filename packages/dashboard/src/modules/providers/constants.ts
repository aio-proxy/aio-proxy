import { ProviderProtocol } from "@aio-proxy/types";
import { Claude, Codex, Gemini, OpenAI } from "@lobehub/icons";

export enum ProviderFormMode {
  Create = "create",
  Edit = "edit",
}

export const API_PROVIDER_PROTOCOLS = [
  {
    value: ProviderProtocol.OpenAICompatible,
    label: "OpenAI Compatible",
    icon: OpenAI,
  },
  {
    value: ProviderProtocol.OpenAIResponse,
    label: "OpenAI Response",
    icon: Codex.Color,
  },
  {
    value: ProviderProtocol.Anthropic,
    label: "Anthropic",
    icon: Claude.Color,
  },
  {
    value: ProviderProtocol.Gemini,
    label: "Gemini",
    icon: Gemini.Color,
  },
];
