import { useEffect, useRef } from "react";
import { epitaxyHostCommandAllowed, epitaxyRoute } from "./epitaxySecurity.js";

/**
 * Isolated artifact preview for seven Epitaxy MIME flavors. Code-like types
 * are inert text until a dedicated audited renderer is available.
 */
export function EpitaxyIframeBridge({
  content,
  mimeType,
  onCommand,
  onError,
}: {
  content: string;
  mimeType: string;
  onCommand?: (payload: unknown) => void;
  onError?: (error: unknown) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const route = epitaxyRoute(mimeType);

  useEffect(() => {
    if (route !== "frame") return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== "null") return;
      const raw: unknown = event.data;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
      const data = raw as Record<string, unknown>;
      if (data.channel === "epitaxy_mcp_app") {
        // Never pass synthetic/unproven messages to host commands.
        // A MessageEvent normally carries NO userActivation; fail closed.
        if (!epitaxyHostCommandAllowed(event)) return;
        onCommand?.(data.payload);
      } else if (data.type === "EPITAXY_RUNTIME_ERROR") {
        onError?.(data.payload);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [route, onCommand, onError]);

  if (route === "unsupported") return null;
  if (route === "text") {
    return (
      <pre className="h-full w-full overflow-auto whitespace-pre-wrap break-words p-3 text-xs">
        <code>{content}</code>
      </pre>
    );
  }
  return (
    <iframe
      ref={frame}
      title="Isolated artifact preview"
      srcDoc={content}
      sandbox="allow-scripts allow-forms allow-modals"
      referrerPolicy="no-referrer"
      className="h-full w-full border-0 bg-transparent"
      data-testid="epitaxy-artifact-frame"
    />
  );
}
