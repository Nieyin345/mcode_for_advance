/** Minimal IPC fake: all calls are in-memory, no preload or user devices. */
let onStop: (id: string) => Promise<{ text: string }> = async () => ({ text: "" });
let onStart: (id: string) => Promise<void> = async () => {};
export const started: string[] = [];
export const cancelled: string[] = [];
export function configureVoice(options: {
  stop?: (id: string) => Promise<{ text: string }>;
  start?: (id: string) => Promise<void>;
} = {}): void {
  started.length = 0;
  cancelled.length = 0;
  onStop = options.stop ?? (async () => ({ text: "" }));
  onStart = options.start ?? (async () => {});
}
export const api = {
  voice: {
    start(input: { sessionId: string }): Promise<void> {
      started.push(input.sessionId);
      return onStart(input.sessionId);
    },
    stop(input: { sessionId: string }): Promise<{ text: string }> {
      return onStop(input.sessionId);
    },
    feed(_input: unknown): Promise<void> { return Promise.resolve(); },
    cancel(input: { sessionId: string }): Promise<void> {
      cancelled.push(input.sessionId);
      return Promise.resolve();
    },
  },
  on: { voiceResult(_fn: (msg: unknown) => void): () => void { return () => {}; } },
};
