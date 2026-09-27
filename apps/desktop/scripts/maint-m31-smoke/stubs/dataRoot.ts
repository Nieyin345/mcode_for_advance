export function dataRoot(): string {
  if (!process.env.M31_TEST_DATA_ROOT) throw Error('M31 isolated data root is required');
  return process.env.M31_TEST_DATA_ROOT;
}
