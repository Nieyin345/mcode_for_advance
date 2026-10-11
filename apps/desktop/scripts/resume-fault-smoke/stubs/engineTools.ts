/** 四个引擎工具域的描述符/调用桩。Codex 的 buildDynamicTools 只取 descriptors/isXxx。 */
export const memoryToolDescriptors = () => [];
export const invokeMemoryTool = async () => ({ isError: false, content: [] });
export const appToolDescriptors = () => [];
export const invokeAppEngineTool = async () => ({ isError: false, content: [] });
export const isAppToolName = () => false;
export const libraryToolDescriptors = () => [];
export const invokeLibraryTool = async () => ({ isError: false, content: [] });
export const invokeLibraryToolGated = async () => ({ isError: false, content: [] });
export const isLibraryToolName = () => false;
export const isLibraryReadonlyTool = () => false;
