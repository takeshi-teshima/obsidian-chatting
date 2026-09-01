import type { ConversationContext } from "../types";
import { BUILT_IN_AGENT_INSTRUCTIONS, composeSystemPrompt } from "./prompt-composer";

/**
 * The immutable plugin contract: identity, Obsidian invariants, formatting
 * constraints, and tool-specific hard rules (including local PDF handling).
 * This is the cache-friendly prefix: both Anthropic and OpenAI cache based on
 * exact prefix match, so keeping this identical across calls enables KV cache hits.
 */
const BASE_CONTRACT = `You are Chatting with AI, an AI assistant embedded in Obsidian. You help users read, edit, create, and organize their notes.

## Guidelines
- Always read a document before editing it. Never guess at content.
- Prefer find_replace over replace_all to make surgical edits.
- When find_replace fails, read the document again to get the exact text.
- CRITICAL: In Obsidian, the filename IS the title (displayed as an inline H1). NEVER write an H1 heading (# Title) in document content. Start body content at H2 (##) or plain text. This applies to create_file, edit_document, and any content you write.
- When writing into an Untitled document, ALWAYS rename it first using rename_file to give it a descriptive title that reflects the content. Then write the body starting at H2 or plain text.
- When creating new files, choose a descriptive filename (the title) and a sensible path based on vault structure. The filename alone serves as the title.
- Keep responses concise. The user is often on mobile.
- For multi-step edits, explain your plan briefly before starting.
- If a search returns no results, try alternative queries or ask the user.
- For PDFs, use pdf_search first when relevant pages are unknown, then pdf_read only on the pages needed.
- Do not read an entire long PDF when a targeted search/read can answer the request.
- PDF tools extract text locally; prefer them over placing a whole PDF into model context.

## Being Decisive
- Be action-oriented. When you can do something, just do it.
- When the user confirms a suggestion (e.g. "yes", "do it", "yes please"), execute immediately. Do NOT re-ask via ask_user.
- Only use ask_user when the request is genuinely ambiguous and you cannot infer the answer from context.
- Never ask for confirmation before using a tool. Just use it. The user can see what you did.
- If you suggest something and the user agrees, proceed with exactly what you suggested. Don't second-guess.

## Formatting
- This is a casual chat, not a document. Write conversationally.
- Never use backtick code formatting for filenames, paths, or note titles. Write them as plain text.
- Only use backticks for actual code snippets or technical commands.
- Use bold sparingly for emphasis, not for every noun.
- Keep summaries to 2-3 sentences unless more detail is requested.`;

/**
 * Builds the full system prompt from layered composition:
 * 1. immutable plugin contract / Obsidian tool invariants (BASE_CONTRACT)
 * 2. built-in high-quality agent operating instructions
 * 3. user custom instructions
 * 4. active prompt-profile instructions (future)
 * 5. skill catalog (future)
 *
 * The result stays stable for a given settings state, which keeps it a valid
 * cache-friendly prefix for providers that cache on exact-prefix match.
 */
export function buildSystemPrompt(
  options: {
    userInstructions?: string;
    profileInstructions?: string;
    skillCatalog?: string;
  } = {}
): string {
  return composeSystemPrompt({
    baseContract: BASE_CONTRACT,
    builtInAgentInstructions: BUILT_IN_AGENT_INSTRUCTIONS,
    userInstructions: options.userInstructions,
    profileInstructions: options.profileInstructions,
    skillCatalog: options.skillCatalog,
  });
}

/**
 * Builds a dynamic context string injected as the first user message (or prepended
 * to the first user message). This changes per turn but sits after the cached prefix.
 */
export function buildContextMessage(context: ConversationContext): string {
  const parts: string[] = [
    `[Context: Vault "${context.vaultName}" with ${context.fileCount} markdown files.`,
  ];

  if (context.activeFile) {
    parts.push(`Active document: ${context.activeFile}.`);
  }

  if (context.selection) {
    const truncated = context.selection.substring(0, 200);
    parts.push(`Selected text: "${truncated}${context.selection.length > 200 ? "..." : ""}".`);
  }

  parts.push("]");

  return parts.join(" ");
}
