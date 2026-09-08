export interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  userInvocable: boolean;
  source: "builtin" | "vault";
}

export interface SkillDocument extends SkillMetadata {
  body: string;
}
