import type { ChatSettings, UnifiedMessage } from "../types";
import type { ContextRef } from "../context/refs";
import { getModelCapabilities } from "../model/capabilities";
import {
  assertImageRefEnvelope,
  type ImageResolver,
} from "../context/image-resolver";
import type { ProviderConversationState } from "./provider-session-state";

export interface ProviderRequestContext {
  /** Present for normal AgentLoop requests; optional for text-only connection tests. */
  images?: ImageResolver;
  /**
   * Per-SessionRuntime mutable provider continuation state (e.g. OpenAI's
   * `previous_response_id`). Must never be a module-level global — each
   * runtime owns its own instance. Optional for one-off calls (e.g. the
   * settings "Test connection" check) that never chain turns.
   */
  providerState?: ProviderConversationState;
}

export function imageRefsForMessage(message: UnifiedMessage): ContextRef[] {
  return (message.contextRefs ?? []).filter((ref) => ref.kind === "image");
}

export function hasImageInputs(messages: readonly UnifiedMessage[]): boolean {
  return messages.some((message) => imageRefsForMessage(message).length > 0);
}

/** Fail locally before constructing a provider request. */
export function assertImageMessagesSupported(
  settings: ChatSettings,
  messages: readonly UnifiedMessage[],
): void {
  const messagesWithImages = messages.filter((message) => imageRefsForMessage(message).length > 0);
  if (messagesWithImages.length === 0) return;

  const capabilities = getModelCapabilities(settings.provider, settings.model);
  if (!capabilities.input.image) {
    throw new Error(
      `The selected model (${settings.model || "unknown"}) is not known to support image input ` +
      `for provider ${settings.provider}. Choose a vision-capable model or remove the image attachment.`,
    );
  }

  for (const message of messagesWithImages) {
    if (message.role !== "user") {
      throw new Error("Image context may only be attached to user messages.");
    }
    assertImageRefEnvelope(message.contextRefs ?? []);
  }
}

/**
 * Builds Anthropic Messages API content for a user message with image refs.
 * Returns null when the message has no images so the adapter can preserve its
 * existing text/tool serialization unchanged.
 */
export async function buildAnthropicVisionContent(
  message: UnifiedMessage,
  resolver: ImageResolver | undefined,
): Promise<Array<Record<string, unknown>> | null> {
  const refs = imageRefsForMessage(message);
  if (refs.length === 0) return null;
  if (message.role !== "user") throw new Error("Anthropic image inputs must belong to a user message.");
  if (!resolver) throw new Error("Image resolver is unavailable for an image-bearing request.");
  if (typeof message.content !== "string") {
    throw new Error("Image attachments are only supported on ordinary user-text messages, not tool-result blocks.");
  }

  assertImageRefEnvelope(refs);
  const content: Array<Record<string, unknown>> = [];

  // Anthropic recommends placing images before the text prompt when practical.
  for (const ref of refs) {
    const image = await resolver.resolve(ref);
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mime,
        data: image.base64,
      },
    });
  }

  if (message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  }
  return content;
}

/**
 * Builds Responses-style content used by both api.openai.com and the
 * ChatGPT/Codex Responses backend.
 */
export async function buildResponsesVisionContent(
  message: UnifiedMessage,
  resolver: ImageResolver | undefined,
): Promise<Array<Record<string, unknown>> | null> {
  const refs = imageRefsForMessage(message);
  if (refs.length === 0) return null;
  if (message.role !== "user") throw new Error("Responses image inputs must belong to a user message.");
  if (!resolver) throw new Error("Image resolver is unavailable for an image-bearing request.");
  if (typeof message.content !== "string") {
    throw new Error("Image attachments are only supported on ordinary user-text messages, not tool-result blocks.");
  }

  assertImageRefEnvelope(refs);
  const content: Array<Record<string, unknown>> = [];
  for (const ref of refs) {
    const image = await resolver.resolve(ref);
    content.push({
      type: "input_image",
      image_url: image.dataUrl,
      detail: "auto",
    });
  }
  if (message.content.length > 0) {
    content.push({ type: "input_text", text: message.content });
  }
  return content;
}
