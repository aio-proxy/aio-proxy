import { ProviderProtocol } from "@aio-proxy/types";
import Claude from "@lobehub/icons-static-svg/icons/claude-color.svg?react";
import Codex from "@lobehub/icons-static-svg/icons/codex-color.svg?react";
import Gemini from "@lobehub/icons-static-svg/icons/gemini-color.svg?react";
import OpenAI from "@lobehub/icons-static-svg/icons/openai.svg?react";

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
    icon: Codex,
  },
  {
    value: ProviderProtocol.Anthropic,
    label: "Anthropic",
    icon: Claude,
  },
  {
    value: ProviderProtocol.Gemini,
    label: "Gemini",
    icon: Gemini,
  },
];
