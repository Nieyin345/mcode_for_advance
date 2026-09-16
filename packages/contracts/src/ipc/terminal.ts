/**
 * 集成终端(xterm.js + node-pty)的设置键与 RPC 入参。
 *
 * 从 `ipc.ts` 按域拆出(见该文件头)。
 */

import { z } from "zod";

/* ── Integrated terminal (xterm.js + node-pty) ──
 *  PTY processes live in main. Renderer only sees opaque terminalIds and
 *  streams data over push channels. Every create is scoped to a known
 *  project root (cwd must resolve inside that root). */

/** Setting key for the user-preferred shell executable (absolute path or
 *  bare command name). Empty/absent → platform smart default. */
export const TERMINAL_SHELL_SETTING_KEY = "terminal.shell";

/** Snapshot of a live (or just-exited) terminal session. */
export interface TerminalInfo {
  terminalId: string;
  /** Absolute cwd the PTY was spawned with. */
  cwd: string;
  /** Resolved shell executable path/name. */
  shell: string;
  /** OS process id while alive; 0 after exit. */
  pid: number;
  /** Project root this terminal is bound to. */
  projectPath: string;
}

/** Create a new PTY bound to a project. `cwd` defaults to `projectPath`. */
export const TerminalCreateSchema = z.object({
  projectPath: z.string().min(1),
  /** Optional working directory; must resolve inside projectPath. */
  cwd: z.string().min(1).optional(),
  cols: z.number().int().min(1).max(1000).optional(),
  rows: z.number().int().min(1).max(1000).optional(),
  /** Optional shell override for this session only. */
  shell: z.string().min(1).optional(),
});
export type TerminalCreateInput = z.infer<typeof TerminalCreateSchema>;

export const TerminalWriteSchema = z.object({
  terminalId: z.string().min(1),
  data: z.string(),
});
export type TerminalWriteInput = z.infer<typeof TerminalWriteSchema>;

export const TerminalResizeSchema = z.object({
  terminalId: z.string().min(1),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
});
export type TerminalResizeInput = z.infer<typeof TerminalResizeSchema>;

export const TerminalKillSchema = z.object({
  terminalId: z.string().min(1),
});
export type TerminalKillInput = z.infer<typeof TerminalKillSchema>;

export const TerminalListSchema = z.object({
  /** When set, only terminals bound to this project root are returned. */
  projectPath: z.string().min(1).optional(),
});
export type TerminalListInput = z.infer<typeof TerminalListSchema>;

/** Structured result for create — either success fields or ok:false + error. */
export type TerminalCreateResult =
  | {
      ok: true;
      terminalId: string;
      pid: number;
      cwd: string;
      shell: string;
    }
  | { ok: false; error: string };

export interface TerminalOpResult {
  ok: boolean;
  error?: string;
}

