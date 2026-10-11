export const PiModelsStore = {
  async listPublic() {
    return { testprov: { hasApiKey: true, models: [{ id: "m1" }] } };
  },
  resolveApiKey: () => "sk-fake",
};
