import type { App } from "obsidian";
import type { ToolResult } from "../types";
import { SkillService } from "./service";

export async function executeSkillTool(
  app: App,
  toolName: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const service = new SkillService(app);
  if (toolName === "list_skills") {
    const items = await service.list();
    return { result: items.map((s) => `${s.id}\t${s.description}`).join("\n") || "No skills available.", isError: false };
  }
  if (toolName === "read_skill") {
    const id = typeof input.id === "string" ? input.id : "";
    const item = await service.read(id);
    return item
      ? { result: `# ${item.name}\n\n${item.body}`, isError: false }
      : { result: `Skill not found: ${id}`, isError: true };
  }
  if (toolName === "read_skill_resource") {
    const id = typeof input.id === "string" ? input.id : "";
    const path = typeof input.path === "string" ? input.path : "";
    const content = await service.readResource(id, path);
    return content !== null
      ? { result: content, isError: false }
      : { result: `Skill resource not found or invalid: ${id}/${path}`, isError: true };
  }
  return { result: `Unknown skill tool: ${toolName}`, isError: true };
}
