export async function getPluginSkillSources(): Promise<Array<{ rootDir: string; builtin: boolean }>> {
  const rootDir = process.env.MCODE_SKILLS_FIXTURE_PLUGIN_ROOT;
  return rootDir ? [{ rootDir, builtin: false }] : [];
}
