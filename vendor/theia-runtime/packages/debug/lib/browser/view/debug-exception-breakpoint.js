"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DebugExceptionBreakpoint = void 0;
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
const breakpoint_manager_1 = require("../breakpoint/breakpoint-manager");
const dialogs_1 = require("@theia/core/lib/browser/dialogs");
const browser_1 = require("@theia/core/lib/browser");
const core_1 = require("@theia/core");
const debug_breakpoint_1 = require("../model/debug-breakpoint");
const debug_commands_1 = require("../debug-commands");
class DebugExceptionBreakpoint extends debug_breakpoint_1.DebugBreakpoint {
    static create(origin, options) {
        return new this(origin, options);
    }
    constructor(origin, options) {
        super(breakpoint_manager_1.BreakpointManager.EXCEPTION_URI, options);
        this.origin = origin;
        this.options = options;
        this.sessionEnablement = new Set();
        /** Determines which exception breakpoints to show when no session is active. */
        this.persistentlyVisible = false;
        this.onEdit = async () => {
            await this.selectInTree();
            this.commandService.executeCommand(debug_commands_1.DebugCommands.EDIT_BREAKPOINT_CONDITION.id);
        };
        this.toggle = (e) => this.setEnabled(e.currentTarget.checked);
    }
    render(host) {
        this.treeWidget = host;
        return (0, jsx_runtime_1.jsxs)("div", { title: this.origin.raw.description || this.origin.raw.label, className: 'theia-source-breakpoint', children: [(0, jsx_runtime_1.jsx)("span", { className: 'theia-debug-breakpoint-icon' }), (0, jsx_runtime_1.jsx)("input", { type: 'checkbox', checked: this.origin.enabled, onChange: this.toggle }), (0, jsx_runtime_1.jsxs)("span", { className: 'line-info', children: [(0, jsx_runtime_1.jsxs)("span", { className: 'name', children: [this.origin.raw.label, " "] }), this.origin.condition &&
                            (0, jsx_runtime_1.jsxs)("span", { title: core_1.nls.localizeByDefault('Expression condition: {0}', this.origin.condition), className: 'path ' + browser_1.TREE_NODE_INFO_CLASS, children: [this.origin.condition, " "] })] }), this.renderActions()] });
    }
    renderActions() {
        if (this.origin.raw.supportsCondition) {
            return (0, jsx_runtime_1.jsx)("div", { className: 'theia-debug-breakpoint-actions', children: (0, jsx_runtime_1.jsx)("div", { className: (0, browser_1.codicon)('edit', true), title: core_1.nls.localizeByDefault('Edit Condition...'), onClick: this.onEdit }) });
        }
        return undefined;
    }
    setSessionEnablement(sessionId, enabled) {
        if (enabled) {
            this.sessionEnablement.add(sessionId);
        }
        else {
            this.sessionEnablement.delete(sessionId);
        }
    }
    isEnabledForSession(sessionId) {
        return this.sessionEnablement.has(sessionId);
    }
    setPersistentVisibility(visible) {
        this.persistentlyVisible = visible;
    }
    isPersistentlyVisible() {
        return this.persistentlyVisible;
    }
    doRender() {
        return undefined;
    }
    setEnabled(enabled) {
        this.breakpoints.enableBreakpoint(this, enabled);
    }
    remove() {
        this.breakpoints.enableBreakpoint(this, false);
    }
    async editCondition() {
        const inputDialog = new dialogs_1.SingleTextInputDialog({
            title: this.origin.raw.label,
            placeholder: this.origin.raw.conditionDescription,
            initialValue: this.origin.condition
        });
        let condition = await inputDialog.open();
        if (condition === undefined) {
            return;
        }
        if (condition === '') {
            condition = undefined;
        }
        if (condition !== this.origin.condition) {
            this.breakpoints.updateBreakpoint(this, { condition });
        }
    }
    getBreakpointDecoration(message) {
        return {
            className: 'never-decorated',
            message: message ?? []
        };
    }
}
exports.DebugExceptionBreakpoint = DebugExceptionBreakpoint;
//# sourceMappingURL=debug-exception-breakpoint.js.map