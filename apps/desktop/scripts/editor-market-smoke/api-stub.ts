let listener: ((message: any) => void) | undefined;
export const emit = (payload: any) => listener?.({ channel: "market:progress", payload });
export const subscribed = () => !!listener;
export const api = { on: { marketProgress: (callback: (message: any) => void) => { listener=callback; return () => { listener=undefined; }; } } };
