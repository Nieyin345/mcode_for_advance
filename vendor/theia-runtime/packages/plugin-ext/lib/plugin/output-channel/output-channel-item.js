"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OutputChannelImpl = void 0;
class OutputChannelImpl {
    constructor(name, proxy, pluginInfo) {
        this.name = name;
        this.proxy = proxy;
        this.pluginInfo = pluginInfo;
        // Bind methods to preserve 'this' context when passed as callbacks
        // This ensures compatibility with extensions that pass these methods as function references
        this.append = this.append.bind(this);
        this.appendLine = this.appendLine.bind(this);
        this.replace = this.replace.bind(this);
        this.clear = this.clear.bind(this);
        this.show = this.show.bind(this);
        this.hide = this.hide.bind(this);
    }
    dispose() {
        if (!this.disposed) {
            this.proxy.$dispose(this.name).then(() => {
                this.disposed = true;
            });
        }
    }
    append(value) {
        this.validate();
        this.proxy.$append(this.name, value, this.pluginInfo);
    }
    appendLine(value) {
        this.validate();
        this.append(value + '\n');
    }
    replace(value) {
        this.validate();
        this.clear();
        this.append(value);
    }
    clear() {
        this.validate();
        this.proxy.$clear(this.name);
    }
    show(preserveFocusOrColumn, preserveFocus) {
        this.validate();
        if (typeof preserveFocusOrColumn === 'boolean') {
            preserveFocus = preserveFocusOrColumn;
        }
        this.proxy.$reveal(this.name, !!preserveFocus);
    }
    hide() {
        this.validate();
        this.proxy.$close(this.name);
    }
    validate() {
        if (this.disposed) {
            throw new Error('Channel has been closed');
        }
    }
}
exports.OutputChannelImpl = OutputChannelImpl;
//# sourceMappingURL=output-channel-item.js.map