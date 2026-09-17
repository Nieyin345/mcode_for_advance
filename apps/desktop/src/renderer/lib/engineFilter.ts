/**
 * Per-engine skill visibility on the renderer side — the UI twin of the
 * engines matrix (`main/lib/skillEngines.ts`).
 *
 * The composer's `/` menu and the workflow inspector's skill candidates must
 * only offer what the CURRENT session's engine can actually load: a skill the
 * user took away from codex must not appear in a codex session's picker, even
 * though the store still holds it (other engines may still see it).
 *
 * Semantics match the main process exactly: an absent perEngine record, or an
 * absent engine key, means enabled (missing = enabled). Builtin rows carry no
 * perEngine at all — always visible.
 */

/** The engines the matrix knows. Mirrors SKILL_ENGINES on the main side. */
export type MatrixEngine = "claude" | "codex" | "pi";

/** Matrix entry shape as carried by SkillInfo.perEngine / SkillEngineState. */
export type PerEngineState = Partial<Record<MatrixEngine, boolean>>;

/** providerId ("claude-sdk") → matrix engine id ("claude"). Returns null for
 *  unknown provider ids (custom gateways): they are claude-protocol behind a
 *  proxy, and the provider-side allowlist is the authority for those — the UI
 *  stays unfiltered rather than guessing wrong. */
export function engineOfProviderId(providerId: string | null | undefined): MatrixEngine | null {
  const m = /^(claude|codex|pi)-sdk$/.exec(providerId ?? "");
  return (m?.[1] as MatrixEngine | undefined) ?? null;
}

/** Would this skill load under `engine`? Absent record / key = enabled. */
export function skillVisibleToEngine(
  perEngine: PerEngineState | undefined,
  engine: MatrixEngine | null,
): boolean {
  if (!engine) return true;
  return perEngine?.[engine] !== false;
}

/** Narrow a skill list to what `providerId`'s engine may see. Skills without
 *  a perEngine record (builtin, or a stale store entry) pass through. */
export function filterSkillsForEngine<T extends { perEngine?: PerEngineState }>(
  skills: readonly T[],
  providerId: string | null | undefined,
): T[] {
  const engine = engineOfProviderId(providerId);
  if (!engine) return [...skills];
  return skills.filter((s) => skillVisibleToEngine(s.perEngine, engine));
}
