/** F040: opt-in bridge for the REAL product-preload Theia/FileEditor journey.
 * All unrelated App API calls stay on the normal U1 fixture. */
(function () {
  "use strict";
  if (!window.api || !window.api.modules || !window.api.file || !window.api.on) {
    throw new Error("F040 requires the product preload API");
  }
  window.__u1RealTheiaEnabled = true;
  window.__u1MonacoWorkersEnabled = true;
  window.__u1Workers = [];
  window.__u1WorkerAttempts = [];
  window.__u1WorkerErrors = [];
  window.__u1WorkerFallbackWarnings = [];
  for (const method of ["warn", "error"]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      const message = args.map(value => String(value && value.message || value)).join(" ");
      if (/(?:fallback|falling back|fall back|main.thread.{0,20}worker|worker.{0,30}(?:fallback|falling back|disabled|failed))/i.test(message)) {
        window.__u1WorkerFallbackWarnings.push({ method, message: message.slice(0, 1000) });
      }
      original(...args);
    };
  }
  window.__u1TheiaCalls = [];
  window.__u1ProductPreloadCalls = [];
  if (typeof window.Worker === "function") {
    const NativeWorker = window.Worker;
    window.Worker = class McodeU1ObservedWorker extends NativeWorker {
      constructor(url, options) {
        const source = String(url);
        window.__u1WorkerAttempts.push({ url: source, type: options && options.type || "classic" });
        try {
          super(url, options);
        } catch (error) {
          window.__u1WorkerErrors.push({
            url: source, phase: "constructor",
            message: String(error && error.message || error),
          });
          throw error;
        }
        window.__u1Workers.push({ url: source, type: options && options.type || "classic" });
        this.addEventListener("error", function (event) {
          window.__u1WorkerErrors.push({
            url: source, phase: "runtime",
            message: String(event.message || "worker error"),
          });
        });
      }
    };
  }
  const labApi = window.labApi;
  window.labApi = new Proxy(labApi, {
    get(target, namespace) {
      if (namespace === "modules") {
        return new Proxy(target.modules, {
          get(ns, method) {
            if (method === "theiaInstalled") {
              return async (input) => {
                let result;
                try {
                  result = await window.api.modules.theiaInstalled(input);
                } catch (error) {
                  window.__u1ProductPreloadCalls.push({
                    namespace: "modules", method: "theiaInstalled",
                    op: input && input.op, query: input && input.query,
                    rejected: String(error && error.message || error),
                  });
                  throw error;
                }
                const record = { op: input && input.op, query: input && input.query };
                if (input && input.op === "editorSync") {
                  record.filePath = input.editor && input.editor.filePath;
                  record.textLength = input.editor && input.editor.text && input.editor.text.length;
                  record.languageId = input.editor && input.editor.languageId;
                }
                if (input && input.op === "languageQuery" && input.query === "rename") {
                  record.position = { lineNumber: input.lineNumber, column: input.column };
                  record.editContext = input.editContext;
                  record.result = {
                    kind: result.kind,
                    renameLocation: result.renameLocation,
                    renameRejectReason: result.renameRejectReason,
                    renameEdits: result.renameEdits,
                  };
                }
                window.__u1TheiaCalls.push(record);
                window.__u1ProductPreloadCalls.push({
                  namespace: "modules", method: "theiaInstalled", op: record.op,
                  resultKind: result && result.kind,
                });
                if (window.__u1TheiaCalls.length > 200) window.__u1TheiaCalls.shift();
                if (window.__u1ProductPreloadCalls.length > 300) window.__u1ProductPreloadCalls.shift();
                return result;
              };
            }
            return ns[method];
          },
        });
      }
      if (namespace === "runs") {
        return new Proxy(target.runs, {
          get(ns, method) {
            if (method === "history") return () => Promise.resolve([]);
            return ns[method];
          },
        });
      }
      if (namespace === "file") {
        return new Proxy(target.file, {
          get(ns, method) {
            if (method === "readFile") return async (input) => {
              const result = await window.api.file.readFile(input);
              window.__u1ProductPreloadCalls.push({
                namespace: "file", method: "readFile", filePath: input && input.filePath,
                contentLength: result && typeof result.content === "string" ? result.content.length : null,
              });
              return result;
            };
            return ns[method];
          },
        });
      }
      if (namespace === "on") {
        return new Proxy(target.on, {
          get(ns, method) {
            if (method === "theiaContributionChanged" &&
                typeof window.api.on.theiaContributionChanged === "function") {
              return (handler) => {
                window.__u1ProductPreloadCalls.push({
                  namespace: "on", method, action: "subscribe",
                });
                return window.api.on.theiaContributionChanged((event) => {
                  window.__u1ProductPreloadCalls.push({
                    namespace: "on", method, action: "event",
                    sessionId: event && event.sessionId,
                  });
                  if (window.__u1ProductPreloadCalls.length > 300) window.__u1ProductPreloadCalls.shift();
                  return handler(event);
                });
              };
            }
            return ns[method];
          },
        });
      }
      return target[namespace];
    },
  });
})();
