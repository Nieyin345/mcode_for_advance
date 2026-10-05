/** Library-side Markdown preview. Real Crepe, permanently read-only: no save
 * hooks, filesystem writes or Markdown normalization written back to disk. */
import { useEffect, useRef, useState } from "react";
import { Crepe } from "@milkdown/crepe";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import { api } from "@renderer/lib/api.js";
import { fileHrefToPath, isAbsolutePath } from "@renderer/lib/fileLink.js";
import { dirname, resolveRelativePath } from "@renderer/lib/path.js";
import "./markdownPreview.css";

export default function MarkdownPreviewPane({ markdown, filePath }: { markdown: string; filePath?: string }) {
  const mount = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  useEffect(() => {
    if (!mount.current) return;
    let disposed = false;
    setError(null); setFailed([]);
    // A separate root per lifetime prevents a slow prior create/destroy from
    // removing the next document's editor during rapid preview navigation.
    const root = document.createElement("div");
    root.className = "mcode-milkdown";
    mount.current.appendChild(root);
    const requests = new Map<string, Promise<string>>();
    const proxyDomURL = (url: string): Promise<string> | string => {
      if (/^https?:\/\//i.test(url) || /^data:image\/[a-z0-9.+-]+;base64,/i.test(url)) return url;
      const cached = requests.get(url);
      if (cached) return cached;
      const request = (async () => {
        try {
          if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^file:/i.test(url) && !/^[a-z]:[\\/]/i.test(url)) throw new Error("Unsupported image URL");
          const local = fileHrefToPath(url);
          if (!local || (!isAbsolutePath(local) && !filePath)) throw new Error("Markdown path unavailable");
          const target = isAbsolutePath(local) ? local : resolveRelativePath(dirname(filePath!), local);
          // Reuse the existing guarded binary IPC; do not grant extra roots or
          // expose a file:// URL to Chromium. Source Markdown stays untouched.
          const { dataUrl } = await api.file.readBinary({ filePath: target });
          if (!/^data:image\//i.test(dataUrl)) throw new Error("Not an image");
          return disposed ? "" : dataUrl;
        } catch {
          if (!disposed) setFailed(values => values.includes(url) ? values : [...values, url]);
          return "";
        }
      })();
      requests.set(url, request);
      return request;
    };
    const crepe = new Crepe({
      root, defaultValue: markdown,
      features: {
        [Crepe.Feature.Toolbar]: false,
        [Crepe.Feature.TopBar]: false,
        [Crepe.Feature.BlockEdit]: false,
        [Crepe.Feature.Placeholder]: false,
      },
      featureConfigs: { [Crepe.Feature.ImageBlock]: { proxyDomURL } },
    });
    crepe.setReadonly(true);
    const creating = crepe.create();
    void creating.catch(reason => { if (!disposed) setError(String(reason)); });
    return () => {
      disposed = true;
      root.remove();
      requests.clear();
      void creating.then(() => crepe.destroy(), () => crepe.destroy()).catch(() => {});
    };
  }, [markdown, filePath]);
  return <div className="mcode-markdown-preview" data-markdown-preview="crepe-readonly" onClickCapture={event => {
    const link = (event.target as Element).closest?.("a[href]");
    // Never let document content navigate the application to an executable or
    // local-file URL. Normal web links retain the app's existing navigation guard.
    if (link && !/^(https?:\/\/|mailto:|#)/i.test(link.getAttribute("href") ?? "")) event.preventDefault();
  }}>
    {error && <div role="alert" className="p-3 text-xs text-red-500">Markdown 预览失败 / Preview failed: {error}</div>}
    {failed.length > 0 && <div role="status" className="p-3 text-xs text-content-muted">部分图片无法读取（文件缺失或读取受限） / Some images could not be loaded: {failed.length}</div>}
    <div ref={mount} />
  </div>;
}
