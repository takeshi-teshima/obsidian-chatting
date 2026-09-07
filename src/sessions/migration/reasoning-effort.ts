import type { ReasoningEffort } from "../../model/capabilities";

const SUPPORTED_EFFORTS: readonly ReasoningEffort[] = ["auto", "low", "medium", "high", "max"];

/**
 * The final stacked ReasoningEffort contract is `auto | low | medium | high | max`.
 * An earlier kit iteration (and some legacy persisted sessions) may carry an
 * unsupported value such as `minimal`. Per MIGRATION_HANDOFF.md "Reasoning
 * effort compatibility": do NOT silently coerce an unsupported value to the
 * nearest supported one (e.g. `minimal` -> `low`) — omit it and let the
 * caller record a migration diagnostic instead.
 */
export function normalizeLegacyReasoningEffort(
  value: unknown,
): { effort: ReasoningEffort } | { effort: undefined; unsupported: string } {
  if (typeof value !== "string") return { effort: undefined, unsupported: String(value) };
  if ((SUPPORTED_EFFORTS as readonly string[]).includes(value)) {
    return { effort: value as ReasoningEffort };
  }
  return { effort: undefined, unsupported: value };
}
