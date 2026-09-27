// Fail closed if a wiring regression tries to execute a real shell or model helper.
export function spawnRun(..._args: unknown[]): never {
  throw new Error("This module workflow smoke must not launch external code");
}
