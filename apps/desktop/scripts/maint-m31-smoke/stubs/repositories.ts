export const ProjectRepo = {
  listPaths: (): string[] => process.env.M31_TEST_PROJECT_ALIAS ? [process.env.M31_TEST_PROJECT_ALIAS] : [],
};
export const SessionRepo = { listWorktreeRoots: (): string[] => [] };
