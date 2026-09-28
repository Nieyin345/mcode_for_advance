export const ProjectRepo = { list: () => JSON.parse(process.env.MCODE_SKILLS_FIXTURE_PROJECTS ?? "[]") as Array<{ id: string; name: string; path: string }> };
