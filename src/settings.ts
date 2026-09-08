import { App, Modal, Notice, PluginSettingTab, Setting, requestUrl } from "obsidian";
import type ChatPlugin from "./main";
import type { Provider, ChatSettings } from "./types";
import { CHATGPT_OAUTH_DEFAULT_MODEL } from "./types";
import type { ChatGPTDeviceAuthorization, PollHandle } from "./auth/chatgptOAuth";
import { PromptProfileService } from "./profiles/service";
import {
  FALLBACK_MODELS,
  getModelDisplayName,
  getModelOptions,
  setSettingsSource,
  writeCustomCatalog,
  type ModelOption,
} from "./model-catalog";

// Re-exported so existing call sites (src/main.ts, src/ui/chat-view.ts,
// src/turn-execution/catalog.ts) that `import { getModelOptions, ... } from
// "./settings"` keep working unchanged — the actual implementation now
// lives in src/model-catalog.ts (kept free of "obsidian" imports so it, and
// the persistence it backs, can be exercised by a plain-Node regression
// check without pulling in Obsidian runtime stubs).
export { getModelDisplayName, getModelOptions, setSettingsSource };

// ─── Settings Tab ───────────────────────────────────────────────────────────

export class ChatSettingTab extends PluginSettingTab {
  plugin: ChatPlugin;

  constructor(app: App, plugin: ChatPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    // ─── Provider (credential configuration target only) ───────────────
    // This no longer chooses "the" active chat provider/model — that is now
    // owned by the composer's per-conversation model picker (Session
    // Workspaces v4.3, branch 14: Claudian-style model selection). It only
    // selects which provider's credentials the section below edits.
    new Setting(containerEl)
      .setName("Provider to configure")
      .setDesc("Which provider's credentials to set up below. The model actually used by a conversation is chosen in the composer, not here.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("anthropic", "Anthropic")
          .addOption("openai", "OpenAI")
          .addOption("chatgpt-oauth", "ChatGPT OAuth")
          .setValue(s.provider)
          .onChange(async (value) => {
            // Load the new provider's key BEFORE saving,
            // otherwise the old provider's key gets saved under the new provider name
            s.provider = value as Provider;
            this.plugin.reloadApiKeyForProvider();
            await this.plugin.saveSettings();
            window.setTimeout(() => this.display(), 10);
          })
      );

    // ─── Auth section: API key OR OAuth Connect ───────────────────────
    if (s.provider === "chatgpt-oauth") {
      this.renderChatGPTOAuthSection(containerEl);
    } else {
      this.renderApiKeySection(containerEl);
    }

    // ─── Model ────────────────────────────────────────────────────────
    this.renderModelSection(containerEl);

    // ─── Reasoning effort ───────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Default reasoning effort")
      .setDesc(
        "Seed value for new conversations only. Unsupported levels are mapped down conservatively per model. Change it per-conversation in the composer's reasoning selector."
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("auto", "Auto (recommended)")
          .addOption("low", "Low")
          .addOption("medium", "Medium")
          .addOption("high", "High")
          .addOption("max", "Max")
          .setValue(s.reasoningEffort)
          .onChange(async (value) => {
            s.reasoningEffort = value as ChatSettings["reasoningEffort"];
            await this.plugin.saveSettings();
          })
      );

    // ─── Web search ───────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Web search")
      .setDesc("Allow the model to search the web when it needs current information")
      .addToggle((toggle) =>
        toggle
          .setValue(s.enableWebSearch)
          .onChange(async (value) => {
            s.enableWebSearch = value;
            await this.plugin.saveSettings();
          })
      );

    // ─── Max iterations ───────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Max tool iterations")
      .setDesc("Safety limit for the agent loop (default: 20)")
      .addText((text) =>
        text
          .setPlaceholder("20")
          .setValue(String(s.maxIterations))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n > 0 && n <= 100) {
              s.maxIterations = n;
              await this.plugin.saveSettings();
            }
          })
      );

    // ─── Custom instructions ────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Custom instructions")
      .setDesc(
        "Instructions applied to every chat. Keep project-specific workflows in Skills rather than putting everything here."
      )
      .addTextArea((textarea) => {
        textarea
          .setPlaceholder("e.g. Prefer terse, technical responses. Always use ISO dates.")
          .setValue(s.customInstructions)
          .onChange(async (value) => {
            s.customInstructions = value;
            await this.plugin.saveSettings();
          });
        textarea.inputEl.rows = 6;
        textarea.inputEl.addClass("chatting-with-ai-custom-instructions");
      });

    // ─── Prompt profile ─────────────────────────────────────────────────
    this.renderPromptProfileSection(containerEl);
  }

  // ─── Prompt profiles (AI/Prompts/**/*.md) ──────────────────────────────

  private renderPromptProfileSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const profileService = new PromptProfileService(this.app);
    const profiles = profileService.list();

    // Defensive fallback: if the currently-selected profile id no longer
    // resolves to a file, degrade to "None" in the UI. This never blocks
    // chat — PromptProfileService.resolve() already degrades gracefully
    // at request time regardless of what's shown here.
    const activeExists = !s.activeProfileId || profiles.some((p) => p.id === s.activeProfileId);

    new Setting(containerEl)
      .setName("Prompt profile")
      .setDesc(
        profiles.length > 0
          ? "Markdown-backed profiles discovered under AI/Prompts. Edit the files directly in Obsidian to change instructions, model, effort, web search, or skills."
          : "No profiles found under AI/Prompts. Create a Markdown file there (with optional frontmatter: name, description, model, effort, webSearch, skills) to add one."
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("__none__", "None / Global defaults");
        for (const p of profiles) {
          dropdown.addOption(p.id, p.name);
        }
        if (s.activeProfileId && !activeExists) {
          dropdown.addOption(s.activeProfileId, `${s.activeProfileId} (missing)`);
        }
        dropdown.setValue(s.activeProfileId ?? "__none__");
        dropdown.onChange(async (value) => {
          s.activeProfileId = value === "__none__" ? null : value;
          await this.plugin.saveSettings();
        });
      });
  }

  // ─── API key + test (anthropic / openai) ──────────────────────────────────

  private renderApiKeySection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;

    const apiKeySetting = new Setting(containerEl)
      .setName("API key")
      .setDesc(s.apiKey ? "Key saved" : "Enter your API key to get started")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Enter your API key")
          .setValue(s.apiKey)
          .onChange(async (value) => {
            const hadKey = !!s.apiKey;
            s.apiKey = value.trim();
            await this.plugin.saveSettings();
            if (!hadKey && s.apiKey) {
              window.setTimeout(() => this.display(), 10);
            }
          });
      });

    if (s.apiKey) {
      apiKeySetting.addButton((button) =>
        button.setButtonText("Test").onClick(async () => {
          button.setButtonText("Testing...");
          button.setDisabled(true);
          try {
            const { sendMessage } = await import("./api/client");
            const response = await sendMessage(
              s,
              [{ role: "user", content: "Say hello in one word." }],
              [],
              "You are a test. Respond with one word."
            );
            const text = response.content
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .join("");
            new Notice(`Connected! Response: "${text}"`);
            apiKeySetting.setDesc("Connection successful");
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            new Notice(`Connection failed: ${msg}`);
            apiKeySetting.setDesc(`Failed: ${msg}`);
          } finally {
            button.setButtonText("Test");
            button.setDisabled(false);
          }
        })
      );
    }
  }

  // ─── ChatGPT OAuth ────────────────────────────────────────────────────────

  private renderChatGPTOAuthSection(containerEl: HTMLElement): void {
    const credential = this.plugin.chatgptOAuth.getCredential();

    const explainer = containerEl.createEl("div", {
      cls: "setting-item-description ochatting-oauth-explainer",
    });
    explainer.createSpan({
      text: "Sign in with your ChatGPT account instead of using an OpenAI API key. Requests are routed through the ChatGPT/Codex backend (not ",
    });
    explainer.createEl("code", { text: "api.openai.com" });
    explainer.createSpan({
      text: ") and require an active ChatGPT plan with Codex access. The available models mirror the Codex CLI catalog.",
    });

    if (credential) {
      const account = credential.accountId
        ? maskAccountId(credential.accountId)
        : "(no account id)";
      const expires = new Date(credential.expiresAt).toLocaleString();
      new Setting(containerEl)
        .setName("ChatGPT account")
        .setDesc(`Connected — account ${account}. Token expires ${expires}.`)
        .addButton((button) =>
          button
            .setButtonText("Disconnect")
            .setWarning()
            .onClick(async () => {
              this.plugin.chatgptOAuth.clearCredential();
              new Notice("ChatGPT OAuth disconnected.");
              this.display();
            })
        )
        .addButton((button) =>
          button.setButtonText("Test").onClick(async () => {
            button.setButtonText("Testing...");
            button.setDisabled(true);
            try {
              const { sendMessage } = await import("./api/client");
              const response = await sendMessage(
                this.plugin.settings,
                [{ role: "user", content: "Say hello in one word." }],
                [],
                "You are a test. Respond with one word."
              );
              const text = response.content
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("");
              new Notice(`Connected! Response: "${text || "(no text)"}"`);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              new Notice(`Connection test failed: ${msg}`);
            } finally {
              button.setButtonText("Test");
              button.setDisabled(false);
            }
          })
        );
    } else {
      new Setting(containerEl)
        .setName("ChatGPT account")
        .setDesc("Not connected. Sign in with ChatGPT to use this provider.")
        .addButton((button) =>
          button
            .setButtonText("Connect ChatGPT")
            .setCta()
            .onClick(async () => {
              try {
                const auth = await this.plugin.chatgptOAuth.beginDeviceAuthorization();
                const handle = this.plugin.chatgptOAuth.pollDeviceAuthorization(auth);
                const modal = new ChatGPTDeviceLoginModal(this.app, auth, handle, () => {
                  this.display();
                });
                modal.open();
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                new Notice(`Failed to start ChatGPT login: ${msg}`);
              }
            })
        );
    }
  }

  // ─── Model picker ─────────────────────────────────────────────────────────

  /**
   * Model CATALOG maintenance for the provider currently being configured
   * above — not an execution-model selector. Which model actually runs a
   * turn is chosen in the composer (src/ui/ModelSelector.svelte), which
   * always edits the bound conversation's next-turn selection
   * (SessionMetadata.selectedModel / TurnExecutionConfig at Send). Settings
   * only lets you (a) fetch the current provider's model list into the
   * catalog the composer reads from, and (b) register a custom model ID
   * that isn't in the bundled/fetched list yet.
   */
  private renderModelSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const custom = s.customModelCatalog?.[s.provider];

    const catalogSetting = new Setting(containerEl)
      .setName("Model catalog")
      .setDesc(
        custom && custom.length > 0
          ? `${custom.length} models available for ${s.provider} in the composer's model picker (persisted, syncs across devices).`
          : "Using the bundled default list. Fetch to refresh from the provider's API, or add a custom model ID below."
      );

    // Refresh button — only for providers that ship a meaningful model
    // catalog endpoint behind their auth.
    //
    // chatgpt-oauth is intentionally excluded. The Codex backend either
    // returns the same five slugs we already hardcode, or returns the
    // chat.com UI catalog (dash-form slugs the /responses endpoint then
    // rejects). A live fetch adds zero value and creates confusing failure
    // modes. Users who need a non-default Codex slug can add it as custom.
    const canFetchModels =
      (s.provider === "anthropic" && !!s.apiKey) ||
      (s.provider === "openai" && !!s.apiKey);
    if (canFetchModels) {
      catalogSetting.addButton((btn) =>
        btn
          .setIcon("refresh-cw")
          .setTooltip("Fetch models from API")
          .onClick(async () => {
            btn.setDisabled(true);
            try {
              const fetched = await fetchModelsFromAPI(s.provider, s.apiKey);
              await writeCustomCatalog(this.plugin, s.provider, fetched);
              new Notice(`Loaded ${fetched.length} models. Pick one in the composer's model selector.`);
              this.display();
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              new Notice(`Failed to fetch models: ${msg}`);
            }
          })
      );
    }

    // Add-a-custom-model-ID: extends the catalog the composer reads from; it
    // does not itself select anything for execution.
    let customModelId = "";
    new Setting(containerEl)
      .setName("Add custom model ID")
      .setDesc(`Adds a model to ${s.provider}'s catalog in the composer's picker (does not select it).`)
      .addText((text) =>
        text
          .setPlaceholder(
            s.provider === "anthropic"
              ? "claude-sonnet-4-20250514"
              : s.provider === "chatgpt-oauth"
                ? CHATGPT_OAUTH_DEFAULT_MODEL
                : "gpt-4o",
          )
          .onChange((value) => { customModelId = value.trim(); })
      )
      .addButton((btn) =>
        btn.setButtonText("Add").onClick(async () => {
          if (!customModelId) return;
          const existing = s.customModelCatalog?.[s.provider] ?? [...(FALLBACK_MODELS[s.provider] ?? [])];
          if (!existing.some((m) => m.value === customModelId)) {
            await writeCustomCatalog(this.plugin, s.provider, [
              ...existing,
              { value: customModelId, label: customModelId },
            ]);
          }
          new Notice(`Added ${customModelId} to ${s.provider}'s catalog.`);
          customModelId = "";
          this.display();
        })
      );

    // ─── Catalog list: bundled fallback + persisted custom/fetched entries,
    // de-duplicated by value. Only persisted entries (the ones the user
    // fetched or typed in) are deletable — the bundled list isn't user data.
    const persisted = s.customModelCatalog?.[s.provider] ?? [];
    const persistedValues = new Set(persisted.map((m) => m.value));
    const merged: ModelOption[] = [...persisted];
    for (const fallback of FALLBACK_MODELS[s.provider] ?? []) {
      if (!persistedValues.has(fallback.value)) merged.push(fallback);
    }

    if (merged.length > 0) {
      const listContainer = containerEl.createDiv({ cls: "ochatting-model-catalog-list" });
      for (const model of merged) {
        const deletable = persistedValues.has(model.value);
        const row = new Setting(listContainer)
          .setName(model.label)
          .setDesc(deletable ? `${model.value} (custom/fetched)` : `${model.value} (bundled default)`);
        if (deletable) {
          row.addButton((btn) =>
            btn
              .setIcon("trash-2")
              .setTooltip(`Remove ${model.value}`)
              .onClick(async () => {
                const remaining = persisted.filter((m) => m.value !== model.value);
                await writeCustomCatalog(this.plugin, s.provider, remaining);
                new Notice(`Removed ${model.value} from ${s.provider}'s catalog.`);
                this.display();
              })
          );
        }
      }
    }
  }
}

// ─── Device-flow login modal ────────────────────────────────────────────────

class ChatGPTDeviceLoginModal extends Modal {
  private cancelled = false;

  constructor(
    app: App,
    private readonly authorization: ChatGPTDeviceAuthorization,
    private readonly handle: PollHandle,
    private readonly onComplete: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName("Connect ChatGPT").setHeading();

    contentEl.createEl("p", {
      text: "1. Open this page in any browser:",
    });
    const linkRow = contentEl.createEl("div", { cls: "ochatting-device-link-row" });
    const link = linkRow.createEl("a", {
      text: this.authorization.verificationUri,
      href: this.authorization.verificationUri,
    });
    link.setAttr("target", "_blank");
    link.setAttr("rel", "noopener");

    contentEl.createEl("p", { text: "2. Enter this code on the page:" });
    const codeRow = contentEl.createEl("div", { cls: "ochatting-device-code-row" });

    codeRow.createEl("code", {
      text: this.authorization.userCode,
      cls: "ochatting-device-code",
    });

    const copyBtn = codeRow.createEl("button", { text: "Copy code" });
    copyBtn.addEventListener("click", () => {
      navigator.clipboard
        .writeText(this.authorization.userCode)
        .then(() => new Notice("Code copied."))
        .catch(() => new Notice("Failed to copy code."));
    });

    const status = contentEl.createEl("p", {
      text: "Waiting for authorization. You can return here after signing in.",
      cls: "ochatting-device-status",
    });

    const buttons = contentEl.createEl("div", { cls: "ochatting-device-buttons" });

    const openBtn = buttons.createEl("button", { text: "Open login page" });
    openBtn.classList.add("mod-cta");
    openBtn.addEventListener("click", () => {
      window.open(this.authorization.verificationUri, "_blank");
    });

    const cancelBtn = buttons.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => {
      this.cancelled = true;
      this.handle.cancel();
      this.close();
    });

    // Wait for the poll to finish.
    this.handle.promise
      .then(() => {
        if (this.cancelled) return;
        new Notice("ChatGPT connected.");
        this.onComplete();
        this.close();
      })
      .catch((e: unknown) => {
        if (this.cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        status.setText(`Login failed: ${msg}`);
        status.removeClass("ochatting-device-status");
        status.addClass("ochatting-device-status-error");
      });
  }

  onClose(): void {
    if (!this.cancelled) {
      // If the user closed via Esc / outside click, treat it as cancel.
      this.handle.cancel();
    }
    this.contentEl.empty();
  }
}

function maskAccountId(accountId: string): string {
  if (accountId.length <= 8) return accountId;
  return `${accountId.slice(0, 4)}…${accountId.slice(-4)}`;
}

// ─── Model Fetching (only triggered by explicit refresh button click) ───────

async function fetchModelsFromAPI(
  provider: Provider,
  apiKey: string
): Promise<ModelOption[]> {
  if (provider === "anthropic") {
    return fetchAnthropicModels(apiKey);
  }
  if (provider === "openai") {
    return fetchOpenAIModels(apiKey);
  }
  // chatgpt-oauth never reaches here — the refresh button is hidden for it.
  // We return the bundled list for type-safety, in case a future caller
  // bypasses the UI gate.
  return FALLBACK_MODELS["chatgpt-oauth"];
}

async function fetchAnthropicModels(apiKey: string): Promise<ModelOption[]> {
  let response;
  try {
    response = await requestUrl({
      url: "https://api.anthropic.com/v1/models?limit=100",
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e));
  }

  const models = getModelRecords(response.json as unknown)
    .filter((m) => m.type === "model")
    .filter((m): m is ModelRecord & { id: string } => typeof m.id === "string")
    .map((m) => ({
      value: m.id,
      label: typeof m.display_name === "string" ? m.display_name : m.id,
    }))
    .sort((a: ModelOption, b: ModelOption) => {
      const da = a.value.match(/(\d{8})/)?.[1] || "";
      const db = b.value.match(/(\d{8})/)?.[1] || "";
      return db.localeCompare(da) || a.label.localeCompare(b.label);
    });

  return models.length > 0 ? models : FALLBACK_MODELS.anthropic;
}

async function fetchOpenAIModels(apiKey: string): Promise<ModelOption[]> {
  let response;
  try {
    response = await requestUrl({
      url: "https://api.openai.com/v1/models",
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e));
  }

  const chatPrefixes = ["gpt-", "o1", "o3", "o4", "chatgpt-", "codex-", "gpt5"];
  const excludePatterns = ["realtime", "audio", "transcri", "search"];

  const models = getModelRecords(response.json as unknown)
    .filter((m): m is ModelRecord & { id: string } => typeof m.id === "string")
    .filter((m) => {
      const id = m.id.toLowerCase();
      return chatPrefixes.some((p) => id.startsWith(p)) &&
        !excludePatterns.some((p) => id.includes(p));
    })
    .sort((a, b) =>
      numberValue(b.created) - numberValue(a.created)
    )
    .map((m) => ({ value: m.id, label: m.id }));

  return models.length > 0 ? models : FALLBACK_MODELS.openai;
}

interface ModelRecord {
  id?: unknown;
  type?: unknown;
  display_name?: unknown;
  created?: unknown;
}

function getModelRecords(value: unknown): ModelRecord[] {
  if (!isRecord(value) || !Array.isArray(value.data)) return [];
  return value.data.filter(isRecord);
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
