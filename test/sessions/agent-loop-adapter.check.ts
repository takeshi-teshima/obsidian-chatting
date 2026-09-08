import assert from "node:assert/strict";
import { AgentLoopSessionAdapter, type AgentLoopLike } from "../../src/sessions/runtime/agent-loop-adapter";
import type { UnifiedMessage, ToolResult } from "../../src/types";
import type { SessionAgentCallbacks } from "../../src/sessions/runtime/runtime";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok - ${name}`); })
    .catch((error) => {
      console.error(`  FAIL - ${name}`);
      console.error(error);
      process.exitCode = 1;
      throw error;
    });
}

class FakeLoop implements AgentLoopLike {
  messages: UnifiedMessage[] = [];
  importMessages(messages: UnifiedMessage[]): void { this.messages = messages; }
  exportMessages(): UnifiedMessage[] { return this.messages; }
  abort(): void { /* no-op */ }
  async run(
    text: string,
    callbacks: {
      onThinking: () => void;
      onToolCall: (name: string, input: Record<string, unknown>) => void;
      onToolResult: (name: string, result: ToolResult) => void;
      onResponse: (text: string) => void;
      onAskUser: (question: string) => Promise<string>;
      onError: (message: string) => void;
    },
  ): Promise<void> {
    this.messages.push({ role: "user", content: text });
    callbacks.onThinking();
    this.messages.push({ role: "assistant", content: "ok" });
    callbacks.onResponse("ok");
  }
}

async function main(): Promise<void> {
  console.log("== agent-loop-adapter: turn-execution hooks + provenance stamping ==");
  const loop = new FakeLoop();
  let applied = "";
  let prepared = "";
  const adapter = new AgentLoopSessionAdapter(loop, {
    resetProviderContinuation() { /* no-op */ },
    applyTurnExecution(execution) { applied = `${execution.provider}:${execution.model}:${execution.reasoningEffort}`; },
    prepareProviderContinuation(provider, model) { prepared = `${provider}:${model}`; },
  });
  const callbacks: SessionAgentCallbacks = {
    onThinking() {}, onToolCall() {}, onToolResult() {}, onResponse() {},
    async onAskUser() { return ""; }, onError() {},
  };

  await adapter.run({
    text: "hello",
    execution: { provider: "chatgpt-oauth", model: "gpt-5.6-sol", reasoningEffort: "high" },
  }, callbacks);

  await check("applyTurnExecution hook receives the admitted turn config before run()", () => {
    assert.equal(applied, "chatgpt-oauth:gpt-5.6-sol:high");
  });
  await check("prepareProviderContinuation hook receives provider+model", () => {
    assert.equal(prepared, "chatgpt-oauth:gpt-5.6-sol");
  });
  await check("the canonical user message is stamped with execution provenance", () => {
    const first = loop.messages[0];
    assert.equal(first.execution?.model, "gpt-5.6-sol");
    assert.equal(first.execution?.reasoningEffort, "high");
    assert.equal(first.execution?.provider, "chatgpt-oauth");
  });

  console.log(`\n${passed} checks passed.`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
