export function codexHomePath() {
  return (process.env.MCODE_SMOKE_DATA_ROOT as string) + "/codex-home";
}
export function codexKeyEnvVar(id: string) {
  return `MCODE_CODEX_KEY_${id.toUpperCase()}`;
}
export const CodexModelsStore = {
  async listPublic() {
    return [{ id: "testprov", hasApiKey: true, models: [{ id: "gpt-fake" }] }];
  },
  async ensureConfigMaterialized() {},
  async listMaterializedMcpServers() {
    return [];
  },
  resolveApiKey: () => "sk-fake",
};
