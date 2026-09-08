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

    // ─── Send on Enter ──────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Send on Enter")
      .setDesc(
        "Off (default): Enter inserts a newline like a normal text box; use Cmd+Enter (macOS) " +
          "or Ctrl+Enter (Windows/Linux) to send. On: Enter sends the message and Shift+Enter " +
          "inserts a newline instead."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(s.sendOnEnter)
          .onChange(async (value) => {
            s.sendOnEnter = value;
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

    // ─── Conversation titles ─────────────────────────────────────────────
    this.renderTitleGenerationSection(containerEl);

    // ─── Prompt profile ─────────────────────────────────────────────────
    this.renderPromptProfileSection(containerEl);
  }

  // ─── Conversation titles (auto-generated, Claudian parity) ────────────

  private renderTitleGenerationSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;

    new Setting(containerEl).setName("Conversation titles").setHeading();

    new Setting(containerEl)
      .setName("Auto-generate titles")
      .setDesc(
        "Generate a short title from an LLM after the first exchange in a conversation. " +
          "Can be regenerated later via \"Regenerate conversation title\" (command palette or the conversation list's ⋯ menu)."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(s.titleGenerationEnabled)
          .onChange(async (value) => {
            s.titleGenerationEnabled = value;
            await this.plugin.saveSettings();
          })
      );

    // Provider picker: "Same as conversation" (titleGeneration left
    // undefined) or an explicit provider, in which case a second dropdown
    // lets the user pick a model from that provider's catalog (reusing
    // getModelOptions() — no separate catalog logic).
    const SAME_AS_CONVERSATION = "__same_as_conversation__";
    const selectedProvider = s.titleGeneration?.provider ?? SAME_AS_CONVERSATION;

    const providerSetting = new Setting(containerEl)
      .setName("Title-generation model")
      .setDesc(
        "Which provider+model generates titles. \"Same as conversation\" (default) reuses whatever " +
          "the conversation itself is using — no extra credentials required."
      )
      .addDropdown((dropdown) => {
        dropdown.addOption(SAME_AS_CONVERSATION, "Same as conversation");
        dropdown.addOption("anthropic", "Anthropic");
        dropdown.addOption("openai", "OpenAI");
        dropdown.addOption("chatgpt-oauth", "ChatGPT OAuth");
        dropdown.setValue(selectedProvider);
        dropdown.onChange(async (value) => {
          if (value === SAME_AS_CONVERSATION) {
            s.titleGeneration = undefined;
          } else {
            const provider = value as Provider;
            const existingModel = s.titleGeneration?.provider === provider ? s.titleGeneration.model : undefined;
            s.titleGeneration = { provider, model: existingModel ?? getModelOptions(provider)[0]?.value ?? "" };
          }
          await this.plugin.saveSettings();
          this.display();
        });
      });

    if (selectedProvider !== SAME_AS_CONVERSATION) {
      const provider = selectedProvider as Provider;
      const models = getModelOptions(provider);
      providerSetting.addDropdown((dropdown) => {
        for (const model of models) dropdown.addOption(model.value, model.label);
        const current = s.titleGeneration?.model && models.some((m) => m.value === s.titleGeneration!.model)
          ? s.titleGeneration.model
          : models[0]?.value ?? "";
        dropdown.setValue(current);
        dropdown.onChange(async (value) => {
          s.titleGeneration = { provider, model: value };
          await this.plugin.saveSettings();
        });
      });
    }
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
    const models = getModelOptions(s.provider);
    const defaultModel = models[0];

    // Deliberately just a summary + a button into a dedicated modal now
    // (was previously a flat run of `Setting` rows — fetch button, add-custom
    // row, then one `Setting` per model — rendered at the same visual level
    // as unrelated settings like "Provider to configure"/"Reasoning effort"
    // above and below it, with no way to reorder entries and a hardcoded
    // "(recommended)" string baked into one bundled label that didn't track
    // anything real). The catalog is genuinely orderable data (list
    // position IS the default — see `defaultModelFor()` in main.ts, which
    // literally reads `getModelOptions(provider)[0]`), so it gets a proper
    // list-management UI instead of masquerading as N separate settings.
    new Setting(containerEl)
      .setName("Model catalog")
      .setDesc(
        defaultModel
          ? `${models.length} model${models.length === 1 ? "" : "s"} for ${s.provider}. Default: ${defaultModel.label}.`
          : `No models configured for ${s.provider}.`
      )
      .addButton((btn) =>
        btn
          .setButtonText("Manage models…")
          .onClick(() => {
            new ModelCatalogModal(this.app, this.plugin, s.provider, () => this.display()).open();
          })
      );
  }
}

// ─── Model catalog management (ordering, add/remove, fetch) ────────────────

/**
 * Dedicated modal for managing one provider's model catalog: reorder (list
 * position is the real default — see `renderModelSection`'s comment above),
 * add a custom model ID, fetch from the provider's API, remove an entry, or
 * reset back to the bundled defaults. Kept out of the main settings list so
 * it reads as its own tool rather than N flat rows among unrelated settings.
 */
class ModelCatalogModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: ChatPlugin,
    private readonly provider: Provider,
    private readonly onClose_: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
    this.onClose_();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const s = this.plugin.settings;

    new Setting(contentEl).setName(`Manage models — ${this.provider}`).setHeading();
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Drag order matters: the top model is the default used for new conversations on this provider. Use ▲/▼ to reorder.",
    });

    // The list this modal edits is always the FULL effective catalog
    // (persisted override if one exists, else a copy of the bundled
    // defaults) — not a merge-and-partially-lock split like the old inline
    // UI. Any edit here (reorder, delete, add) writes the whole list back
    // as the provider's persisted override, so bundled entries become fully
    // user-owned (reorderable/deletable) the moment this modal is used.
    // Emptying it out entirely still degrades safely back to the bundled
    // fallback (see `getModelOptions()`/model-catalog-persistence.check.ts),
    // and "Reset to bundled defaults" below does that explicitly.
    const current = s.customModelCatalog?.[this.provider] ?? [...(FALLBACK_MODELS[this.provider] ?? [])];

    const listEl = contentEl.createDiv({ cls: "ochatting-model-catalog-list" });
    current.forEach((model, index) => {
      const row = new Setting(listEl)
        .setName(model.label)
        .setDesc(model.value);
      if (index === 0) {
        row.nameEl.createSpan({ text: " Default", cls: "ochatting-model-catalog-default-badge" });
      }
      row.addExtraButton((btn) =>
        btn
          .setIcon("arrow-up")
          .setTooltip("Move up")
          .setDisabled(index === 0)
          .onClick(async () => {
            const next = [...current];
            [next[index - 1], next[index]] = [next[index], next[index - 1]];
            await writeCustomCatalog(this.plugin, this.provider, next);
            this.render();
          })
      );
      row.addExtraButton((btn) =>
        btn
          .setIcon("arrow-down")
          .setTooltip("Move down")
          .setDisabled(index === current.length - 1)
          .onClick(async () => {
            const next = [...current];
            [next[index], next[index + 1]] = [next[index + 1], next[index]];
            await writeCustomCatalog(this.plugin, this.provider, next);
            this.render();
          })
      );
      row.addButton((btn) =>
        btn
          .setIcon("trash-2")
          .setTooltip(`Remove ${model.value}`)
          .onClick(async () => {
            const next = current.filter((_, i) => i !== index);
            await writeCustomCatalog(this.plugin, this.provider, next);
            this.render();
          })
      );
    });

    // Add-a-custom-model-ID: appended to the end (not the default) unless
    // moved up.
    let customModelId = "";
    new Setting(contentEl)
      .setName("Add custom model ID")
      .setDesc(`Adds a model to the bottom of ${this.provider}'s list above.`)
      .addText((text) =>
        text
          .setPlaceholder(
            this.provider === "anthropic"
              ? "claude-sonnet-4-20250514"
              : this.provider === "chatgpt-oauth"
                ? CHATGPT_OAUTH_DEFAULT_MODEL
                : "gpt-4o",
          )
          .onChange((value) => { customModelId = value.trim(); })
      )
      .addButton((btn) =>
        btn.setButtonText("Add").onClick(async () => {
          if (!customModelId) return;
          if (!current.some((m) => m.value === customModelId)) {
            await writeCustomCatalog(this.plugin, this.provider, [
              ...current,
              { value: customModelId, label: customModelId },
            ]);
          }
          new Notice(`Added ${customModelId}.`);
          customModelId = "";
          this.render();
        })
      );

    // Refresh-from-API — only for providers that ship a meaningful model
    // catalog endpoint behind their auth.
    //
    // chatgpt-oauth is intentionally excluded. The Codex backend either
    // returns the same five slugs we already hardcode, or returns the
    // chat.com UI catalog (dash-form slugs the /responses endpoint then
    // rejects). A live fetch adds zero value and creates confusing failure
    // modes. Users who need a non-default Codex slug can add it as custom.
    const canFetchModels =
      (this.provider === "anthropic" && !!s.apiKey) ||
      (this.provider === "openai" && !!s.apiKey);
    const actionsRow = new Setting(contentEl)
      .setName("Fetch / reset")
      .setDesc("Fetch replaces the list below with the provider's current API catalog. Reset discards any customization and restores the bundled defaults, in their original order.");
    if (canFetchModels) {
      actionsRow.addButton((btn) =>
        btn
          .setIcon("refresh-cw")
          .setTooltip("Fetch models from API")
          .onClick(async () => {
            btn.setDisabled(true);
            try {
              const fetched = await fetchModelsFromAPI(this.provider, s.apiKey);
              await writeCustomCatalog(this.plugin, this.provider, fetched);
              new Notice(`Loaded ${fetched.length} models.`);
              this.render();
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              new Notice(`Failed to fetch models: ${msg}`);
            } finally {
              btn.setDisabled(false);
            }
          })
      );
    }
    actionsRow.addButton((btn) =>
      btn
        .setIcon("rotate-ccw")
        .setTooltip("Reset to bundled defaults")
        .onClick(async () => {
          await writeCustomCatalog(this.plugin, this.provider, []);
          new Notice(`Reset ${this.provider}'s catalog to the bundled defaults.`);
          this.render();
        })
    );
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
