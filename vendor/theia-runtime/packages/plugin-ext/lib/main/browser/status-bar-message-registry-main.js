"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StatusBarMessageRegistryMainImpl = void 0;
const disposable_1 = require("@theia/core/lib/common/disposable");
const types = require("../../plugin/types-impl");
const plugin_api_rpc_1 = require("../../common/plugin-api-rpc");
const status_bar_1 = require("@theia/core/lib/browser/status-bar/status-bar");
const color_registry_1 = require("@theia/core/lib/browser/color-registry");
class StatusBarMessageRegistryMainImpl {
    constructor(container, rpc) {
        this.entries = new Map();
        this.toDispose = new disposable_1.DisposableCollection(disposable_1.Disposable.create(() => { }));
        this.delegate = container.get(status_bar_1.StatusBar);
        this.colorRegistry = container.get(color_registry_1.ColorRegistry);
        this.proxy = rpc.getProxy(plugin_api_rpc_1.MAIN_RPC_CONTEXT.STATUS_BAR_MESSAGE_REGISTRY_EXT);
    }
    dispose() {
        this.toDispose.dispose();
    }
    async $setMessage(id, name, text, priority, alignment, color, backgroundColor, tooltip, command, accessibilityInformation, args) {
        const entry = {
            name,
            text: text || '',
            priority,
            alignment: alignment === types.StatusBarAlignment.Left ? status_bar_1.StatusBarAlignment.LEFT : status_bar_1.StatusBarAlignment.RIGHT,
            color: color && (this.colorRegistry.getCurrentColor(color) || color),
            // In contrast to color, the backgroundColor must be a theme color. Thus, do not hand in the plain string if it cannot be resolved.
            backgroundColor: backgroundColor && (this.colorRegistry.getCurrentColor(backgroundColor)),
            // true is used as a serializable sentinel value to indicate that the tooltip can be retrieved asynchronously
            tooltip: tooltip === true ? (token) => this.proxy.$getMessage(id, token) : tooltip,
            command,
            accessibilityInformation,
            arguments: args
        };
        const isNewEntry = !this.entries.has(id);
        this.entries.set(id, entry);
        await this.delegate.setElement(id, entry);
        if (this.toDispose.disposed) {
            this.$dispose(id);
        }
        else if (isNewEntry) {
            this.toDispose.push(disposable_1.Disposable.create(() => this.$dispose(id)));
        }
    }
    $dispose(id) {
        const entry = this.entries.get(id);
        if (entry) {
            this.entries.delete(id);
            this.delegate.removeElement(id);
        }
    }
}
exports.StatusBarMessageRegistryMainImpl = StatusBarMessageRegistryMainImpl;
//# sourceMappingURL=status-bar-message-registry-main.js.map