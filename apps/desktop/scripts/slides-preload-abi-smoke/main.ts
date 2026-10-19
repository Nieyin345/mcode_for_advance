/**
 * ARC-007 real production documentViewPreload -> fake isolated Electron invoke.
 * Failure must map host {ok:false,reason} into the vendor's null/error shape,
 * otherwise Slides treats a truthy failure envelope as a successful RenderSlide.
 * No actual user file, Electron install or runtime changes.
 */
import { getExposed, getCalls, setupInvoke } from "./stubs/electron.js";
import "../../src/main/document/documentViewPreload.js";

let total = 0, failed = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  total++;
  if (JSON.stringify(actual) === JSON.stringify(expected)) console.log("  ok   " + label);
  else { failed++; console.error("  FAIL " + label + " " + JSON.stringify({ actual, expected })); }
}
const api = getExposed("slidesApi");
const ADD = "mcode:document-view:slides-add-slide";
const EDIT = "mcode:document-view:slides-edit-text";
const SAVE = "mcode:document-view:slides-save";

setupInvoke((_ch) => ({ ok: false, reason: "vendor is unavailable" }));
check("★ failed addBlankSlide must return null (not truthy {ok:false})",
  await api.addBlankSlide({ sourceIndex: 0, fitWidthPx: 1280 }), null);
check("★ addBlankSlide still sends no user-supplied session identity",
  getCalls().map((x) => [x.channel, x.payload]), [[ADD, {}]]);
setupInvoke((_ch) => ({ ok: false, reason: "element not found" }));
check("★ failed editText must return null (not truthy {ok:false})",
  await api.editText({ slideIndex: 0, sourceId: "fake-element", paragraphs: [{ runs: [{ text: "hello" }] }] }), null);
check("★ editText forwards only bounded vendor fields",
  getCalls().map((x) => [x.channel, x.payload]),
  [[EDIT, { slideIndex: 0, elementId: "fake-element", text: "hello" }]]);
setupInvoke((_ch) => ({ ok: false, reason: "file was changed elsewhere" }));
check("★ slides save failure exposes reason as vendor .error",
  await api.save(), { ok: false, error: "file was changed elsewhere" });
check("★ slides save still carries no untrusted path",
  getCalls().map((x) => [x.channel, x.payload]), [[SAVE, {}]]);

setupInvoke((_ch) => ({ ok: true, slides: [], index: 0, nodes: null }));
check("★ malformed add success with no slide is rejected", await api.addBlankSlide({}), null);
check("★ malformed edit success without nodes is rejected",
  await api.editText({ slideIndex: 0, sourceId: "fake", paragraphs: [] }), null);
setupInvoke((_ch) => { throw new Error("FAKE_SLIDES_IPC_FAILURE"); });
check("★ IPC rejection cannot become a successful add",
  await api.addBlankSlide({}), null);
check("★ IPC rejection cannot become a successful edit",
  await api.editText({ slideIndex: 0, sourceId: "fake", paragraphs: [] }), null);
check("★ IPC rejected save displays actual failure reason",
  await api.save(), { ok: false, error: "FAKE_SLIDES_IPC_FAILURE" });

setupInvoke((ch) => {
  if (ch === ADD) return { ok: true, slideCount: 2, slides: [{ nodes: [] }, { nodes: [] }], index: 1 };
  if (ch === EDIT) return { ok: true, text: "hello", nodes: [{ sourceId: "fake-element" }] };
  return { ok: true, path: "fake.pptx", bytes: 1000, slides: [] };
});
const added = await api.addBlankSlide({});
check("★ add success returns real RenderSlide[]", { length: added?.slides?.length, index: added?.index }, { length: 2, index: 1 });
const edited = await api.editText({ slideIndex: 0, sourceId: "fake-element", paragraphs: [{ runs: [{ text: "hello" }] }] });
check("★ edit success returns vendor nodes", edited?.nodes, [{ sourceId: "fake-element" }]);
const saved = await api.save();
check("★ successful save keeps data", { ok: saved?.ok, bytes: saved?.bytes }, { ok: true, bytes: 1000 });
console.log(`slides-preload-abi-smoke: ${total - failed}/${total} 通过`);
if (failed) process.exitCode = 1;
