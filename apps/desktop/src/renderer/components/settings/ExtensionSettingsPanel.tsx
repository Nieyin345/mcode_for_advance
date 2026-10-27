import {TheiaInstalledPanel} from "@renderer/components/modules/TheiaInstalledPanel.js";

/** One settings destination for installed VSIX extensions and Mcode-native
 * ModuleHost contributions. Extension lifecycle and configuration stay out of
 * the workspace's file/module management surface.
 */
export function ExtensionSettingsPanel(){
  return <div className="space-y-6 py-5" data-testid="extension-settings-page">
    <TheiaInstalledPanel/>
  </div>;
}
