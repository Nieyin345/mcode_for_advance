import { api } from "@renderer/lib/api.js";
import { SerializedFileWrites } from "./serializedFileWrites.js";

/** Shared by Markdown panes and the Monaco source save path, including across
 * file switches / unmounts. Both modes must use the SAME queue for each path. */
export const textFileWrites = new SerializedFileWrites(async (filePath, content) => {
  const result = await api.file.writeFile({ filePath, content });
  if (!result.ok) throw new Error("文件写入失败");
});

export const markdownFileWrites = textFileWrites;
