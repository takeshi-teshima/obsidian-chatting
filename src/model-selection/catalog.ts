import type { Provider } from "../types";
import type { ReasoningEffort } from "../model/capabilities";
import type { ComposerModelOption, ComposerReasoningOption } from "./types";

export interface ComposerCatalogHost {
  getEnabledProviders(): readonly Provider[];
  getProviderLabel(provider: Provider): string;
  getProviderIcon?(provider: Provider): string | undefined;
  getModels(provider: Provider): readonly { value: string; label: string; description?: string }[];
  getReasoningEfforts(provider: Provider, model: string): readonly ReasoningEffort[];
  getReasoningLabel?(effort: ReasoningEffort): string;
}

/**
 * A pristine session may expose models across enabled providers, like Claudian's
 * blank-tab selector. A started session is provider-bound and shows only that
 * provider's models.
 */
export function buildComposerModelOptions(
  host: ComposerCatalogHost,
  boundProvider: Provider,
  allowProviderSwitch: boolean,
): ComposerModelOption[] {
  const providers = allowProviderSwitch ? host.getEnabledProviders() : [boundProvider];
  const out: ComposerModelOption[] = [];
  for (const providerId of providers) {
    const group = host.getProviderLabel(providerId);
    const providerIcon = host.getProviderIcon?.(providerId);
    for (const model of host.getModels(providerId)) {
      out.push({
        providerId,
        value: model.value,
        label: model.label,
        ...(model.description ? { description: model.description } : {}),
        group,
        ...(providerIcon ? { providerIcon } : {}),
      });
    }
  }
  return out;
}

export function buildReasoningOptions(
  host: ComposerCatalogHost,
  provider: Provider,
  model: string,
): ComposerReasoningOption[] {
  return host.getReasoningEfforts(provider, model).map((value) => ({
    value,
    label: host.getReasoningLabel?.(value) ?? labelReasoning(value),
  }));
}

function labelReasoning(value: ReasoningEffort): string {
  if (value === "auto") return "Auto";
  if (value === "low") return "Low";
  if (value === "medium") return "Medium";
  if (value === "high") return "High";
  return "Max";
}
