/** T21: behavior tests for the two adapted Claude Desktop reverse-engineered pieces. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { trafficLightSpacerWidth } from "@renderer/components/layout/trafficLights.js";
import { AttachmentTile, attachmentBadge, truncateFileName } from "@renderer/components/chat/AttachmentTile.js";

let total = 0;
let failed = 0;
const eq = (name: string, actual: unknown, expected: unknown) => {
  ++total;
  if (Object.is(actual, expected)) console.log("PASS", name);
  else { ++failed; console.error("FAIL", name, { actual, expected }); }
};
const check = (name: string, ok: boolean) => eq(name, ok, true);

eq("mac normal 74px", trafficLightSpacerWidth("mac", false, 1, false), 74);
eq("mac reverse zoom 80%", trafficLightSpacerWidth("mac", false, 0.8, false), 93);
eq("mac reverse zoom 50%", trafficLightSpacerWidth("mac", false, 0.5, false), 148);
eq("mac zoom-in clamped", trafficLightSpacerWidth("mac", false, 1.25, false), 74);
eq("mac fullscreen collapses", trafficLightSpacerWidth("mac", true, 0.5, false), 0);
eq("mac sidebar owns its slot", trafficLightSpacerWidth("mac", false, 0.5, true), 0);
eq("windows no mac inset", trafficLightSpacerWidth("windows", false, 0.5, false), 0);
eq("linux no mac inset", trafficLightSpacerWidth("linux", false, 0.5, false), 0);
eq("zoom zero guarded", trafficLightSpacerWidth("mac", false, 0, false), 74);

const truncated = truncateFileName("experimental_research_report_final_v3.pdf", 14);
check("file name shortened in the middle", truncated.head.includes("…"));
eq("long file retains PDF extension", truncated.ext, ".pdf");
eq("short name intact", truncateFileName("run.ts", 14).head + truncateFileName("run.ts", 14).ext, "run.ts");
eq("no-extension name shortened", truncateFileName("importantnoteswithoutdot", 14).ext, "");
eq("code extension badge", attachmentBadge("example.ts"), "TS");
eq("python extension badge", attachmentBadge("train.py"), "PY");
eq("PDF badge", attachmentBadge("paper.pdf"), "PDF");
eq("CSV badge", attachmentBadge("metrics.csv"), "CSV");
eq("no extension badge", attachmentBadge("README"), "FILE");

const fileHtml = renderToStaticMarkup(
  <AttachmentTile name="experimental_research_report_final_v3.pdf" onToggle={() => {}} onRemove={() => {}} removeLabel="Remove" />,
);
check("tile rendered using upstream selector", fileHtml.includes('data-cds="MessageAttachmentsFile"') && fileHtml.includes('data-layout="tile"'));
check("tile has 7.5 rem square size", fileHtml.includes("7.5rem"));
check("tile uses card radius", fileHtml.includes("--radius-card"));
check("tile retains extension as separate span", fileHtml.includes(".pdf</span>"));
check("tile has floating delete control", fileHtml.includes('data-cds-attachment-remove=""') && fileHtml.includes("-top-2"));
check("tile badge uppercase", fileHtml.includes(">PDF</span>"));
check("tile uses two layers of shadow", fileHtml.includes("0 1px 3px") && fileHtml.includes("0 6px 16px"));
const imageHtml = renderToStaticMarkup(
  <AttachmentTile name="photo.jpg" imageSrc="data:image/jpeg;base64,AAAA" onRemove={() => {}} removeLabel="Remove image" />,
);
check("image tile has preview", imageHtml.includes('src="data:image/jpeg;base64,AAAA"'));
check("image tile has remove", imageHtml.includes("Remove image"));
const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");
const titlebar = source("src/renderer/components/layout/Titlebar.tsx");
const pane = source("src/renderer/components/chat/ChatPane.tsx");
const chip = source("src/renderer/components/chat/ContentTagChip.tsx");
const tags = source("src/renderer/lib/contentTag.ts");
check("titlebar actually uses calculation", titlebar.includes("trafficLightSpacerWidth(") && titlebar.includes("paddingLeft: trafficLightInset"));
check("mac fullscreen observed", titlebar.includes('fullscreenchange') && titlebar.includes("document.fullscreenElement"));
check("mac 45px only, windows 40px", titlebar.includes('isMac ? "h-[45px]" : "h-10"'));
check("titlebar existing no-drag controls retained", titlebar.includes('WebkitAppRegion: "no-drag"'));
check("chat maps files to tiles", pane.includes('return tag.kind === "file" ? (') && pane.includes("<AttachmentTile"));
check("chat maps text/library/quotes to original chips", pane.includes("<ContentTagChip key={tag.id}"));
check("pending images map to tiles", pane.includes("imageSrc={img.dataUrl}") && pane.includes("removePendingImage(img.id)"));
check("chip code retained", chip.includes("onClick={onToggle}") && chip.includes("onClick={onRemove}"));
check("original full file name available for tile", tags.includes("fileName: name"));
console.log(`T21: ${total - failed}/${total} PASS, ${failed} FAIL`);
if (failed) process.exitCode = 1;
