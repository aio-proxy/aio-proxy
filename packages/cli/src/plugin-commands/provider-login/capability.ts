import type { AtomicConfigFile, OAuthCapabilityReference, PluginRegistry } from "@aio-proxy/core";
import { getLocale, m } from "@aio-proxy/i18n";
import { type LocalizedText, resolveLocalizedText } from "@aio-proxy/plugin-sdk";
import { confirm, select } from "@inquirer/prompts";
import {
  ProviderCapabilityAmbiguousError,
  ProviderCapabilityNotFoundError,
  ProviderTargetInvalidError,
  ProviderTargetNotFoundError,
} from "./errors";

type ConfigRecord = Record<string, unknown>;
export type CapabilityChoice = { readonly reference: string; readonly label: LocalizedText };
type CapabilitySelectPrompt = (config: {
  readonly message: string;
  readonly choices: readonly { readonly name: string; readonly value: string }[];
}) => Promise<string>;

export function canonical(reference: OAuthCapabilityReference): string {
  return `${reference.plugin}#${reference.capability}`;
}

function parseCanonical(value: string): OAuthCapabilityReference | null {
  const separator = value.lastIndexOf("#");
  if (separator <= 0 || separator === value.length - 1) return null;
  return { plugin: value.slice(0, separator), capability: value.slice(separator + 1) };
}

function allCapabilities(
  registry: PluginRegistry,
): readonly (OAuthCapabilityReference & { readonly label: LocalizedText })[] {
  return registry
    .oauthCapabilities()
    .map(({ plugin, capability, adapter }) => ({ plugin, capability, label: adapter.label }))
    .sort((left, right) => canonical(left).localeCompare(canonical(right)));
}

export function createCapabilitySelector(
  prompt: CapabilitySelectPrompt = select as CapabilitySelectPrompt,
): (choices: readonly CapabilityChoice[]) => Promise<string> {
  return (choices) =>
    prompt({
      message: m.cli_provider_login_capability_prompt(),
      choices: choices.map(({ reference, label }) => ({
        name: resolveLocalizedText(label, getLocale()),
        value: reference,
      })),
    });
}

export function createManualOnlyConfirmation(
  signal: AbortSignal,
  prompt: typeof confirm = confirm,
): (redirectUri: string) => Promise<boolean> {
  return (redirectUri) => prompt({ message: redirectUri, default: false }, { signal });
}

export async function chooseCapability(
  inputValue: string | undefined,
  registry: PluginRegistry,
  deps: {
    readonly isTTY: boolean;
    readonly selectCapability: (choices: readonly CapabilityChoice[]) => Promise<string>;
  },
): Promise<OAuthCapabilityReference> {
  const available = allCapabilities(registry);
  let candidates: ReturnType<typeof allCapabilities>;
  if (inputValue === undefined) {
    candidates = available;
  } else {
    const exact = parseCanonical(inputValue);
    if (exact !== null) {
      if (registry.resolveOAuth(exact.plugin, exact.capability) === undefined) {
        throw new ProviderCapabilityNotFoundError(inputValue);
      }
      return exact;
    }
    candidates = available.filter(({ capability }) => capability === inputValue);
  }
  if (candidates.length === 0) throw new ProviderCapabilityNotFoundError(inputValue);
  if (candidates.length === 1 && inputValue !== undefined) return candidates[0] as OAuthCapabilityReference;
  const references = candidates.map(canonical);
  if (!deps.isTTY) {
    if (candidates.length === 1) return candidates[0] as OAuthCapabilityReference;
    throw new ProviderCapabilityAmbiguousError(inputValue ?? "", references);
  }
  const selected = await deps.selectCapability(
    candidates.map((candidate) => ({ reference: canonical(candidate), label: candidate.label })),
  );
  const resolved = parseCanonical(selected);
  if (
    resolved === null ||
    !candidates.some(
      (candidate) => candidate.plugin === resolved.plugin && candidate.capability === resolved.capability,
    )
  ) {
    throw new ProviderCapabilityNotFoundError(selected);
  }
  return resolved;
}

function isRecord(value: unknown): value is ConfigRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function targetCapability(
  providerId: string,
  config: AtomicConfigFile,
): Promise<OAuthCapabilityReference> {
  return config.transaction(async (current) => {
    const providers = isRecord(current.providers) ? current.providers : {};
    const entry = providers[providerId];
    if (entry === undefined) throw new ProviderTargetNotFoundError(providerId);
    if (
      !isRecord(entry) ||
      entry.kind !== "oauth" ||
      Object.hasOwn(entry, "vendor") ||
      typeof entry.plugin !== "string" ||
      typeof entry.capability !== "string"
    ) {
      throw new ProviderTargetInvalidError(providerId);
    }
    return { next: current, result: { plugin: entry.plugin, capability: entry.capability } };
  });
}
