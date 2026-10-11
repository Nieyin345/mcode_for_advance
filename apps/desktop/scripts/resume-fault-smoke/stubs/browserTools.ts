/** 浏览器工具桩:本套件不驱动浏览器,只需名字存在。 */
export const BROWSER_TOOL_SPECS: Record<string, { description: string }> = new Proxy(
  {},
  { get: () => ({ description: "" }) },
);
export const browserToolsUsagePrompt = () => "";
export const browserList = () => ({ isError: false, content: [] });
export const browserNavigate = async () => ({ isError: false, content: [] });
export const browserSnapshot = async () => ({ isError: false, content: [] });
export const browserClick = async () => ({ isError: false, content: [] });
export const browserType = async () => ({ isError: false, content: [] });
export const browserKeys = async () => ({ isError: false, content: [] });
export const browserScroll = async () => ({ isError: false, content: [] });
export const browserWait = async () => ({ isError: false, content: [] });
export const browserHistory = async () => ({ isError: false, content: [] });
export const browserSelect = async () => ({ isError: false, content: [] });
export const browserFind = async () => ({ isError: false, content: [] });
export const browserSwitchTab = async () => ({ isError: false, content: [] });
export const browserCloseTab = async () => ({ isError: false, content: [] });
export const browserUploadFile = async () => ({ isError: false, content: [] });
export const browserSavePdf = async () => ({ isError: false, content: [] });
export const browserDownloads = () => ({ isError: false, content: [] });
export const browserEvaluate = async () => ({ isError: false, content: [] });
export const browserScreenshot = async () => ({ isError: false, content: [] });
