"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DebugBreakpoint = exports.DebugBreakpointDecoration = void 0;
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
const browser_1 = require("@theia/core/lib/browser");
const tree_selection_1 = require("@theia/core/lib/browser/tree/tree-selection");
const core_1 = require("@theia/core");
class DebugBreakpointDecoration {
}
exports.DebugBreakpointDecoration = DebugBreakpointDecoration;
class DebugBreakpoint {
    constructor(uri, options) {
        this.uri = uri;
        this.sessionData = new Map();
        this.setBreakpointEnabled = (event) => {
            this.setEnabled(event.target.checked);
        };
        this.labelProvider = options.labelProvider;
        this.breakpoints = options.breakpoints;
        this.openerService = options.openerService;
        this.commandService = options.commandService;
    }
    get raw() {
        return this._raw;
    }
    update(sessionId, data) {
        if (!data) {
            if (!this.sessionData.has(sessionId)) {
                return false;
            }
            this.sessionData.delete(sessionId);
        }
        else {
            const toSet = { ...data, sessionId };
            this.sessionData.set(sessionId, toSet);
        }
        const verifiedLocations = new Map();
        this.sessionData.forEach(bp => bp.verified && verifiedLocations.set(`${bp.line}:${bp.column}:${bp.instructionReference}`, bp));
        if (verifiedLocations.size === 1) {
            // Exactly one verified location across all sessions — use it.
            this._raw = verifiedLocations.values().next().value;
        }
        else if (verifiedLocations.size === 0) {
            // No session has verified; pick the first session's data (if any) so
            // that capability flags and unverified messages are still available.
            this._raw = this.sessionData.values().next().value;
        }
        else {
            // Multiple sessions verified at different locations. Following
            // VSCode, we set _raw to undefined so that the breakpoint falls
            // back to its user-set position and shows as verified (the
            // default when no resolved data exists). Callers that need a
            // specific session's view can use getDebugProtocolBreakpoint().
            this._raw = undefined;
        }
        return true;
    }
    getIdForSession(sessionId) {
        return this.sessionData.get(sessionId)?.id;
    }
    /** Copied from https://github.com/microsoft/vscode/blob/8934b59d4aa696b6f51ac9bf2eeae8bbac5dac03/src/vs/workbench/contrib/debug/common/debugModel.ts#L953-L971 */
    getDebugProtocolBreakpoint(sessionId) {
        const data = this.sessionData.get(sessionId);
        if (data) {
            const bp = {
                id: data.id,
                verified: data.verified,
                message: data.message,
                source: data.source,
                line: data.line,
                column: data.column,
                endLine: data.endLine,
                endColumn: data.endColumn,
                instructionReference: data.instructionReference,
                offset: data.offset,
            };
            return bp;
        }
        return undefined;
    }
    get id() {
        return this.origin.id;
    }
    get enabled() {
        return this.breakpoints.breakpointsEnabled && this.origin.enabled;
    }
    /**
     * True when at least one session has sent data for this breakpoint
     * (regardless of whether it was verified).
     */
    get installed() {
        return this.sessionData.size > 0;
    }
    /**
     * When resolved session data exists, reflects the adapter's answer.
     * Otherwise returns `true`: either no session has weighed in yet (we
     * haven't been told otherwise) or multiple sessions verified at
     * different locations (`_raw` was cleared to fall back to the user-set
     * position). Matches VSCode's default-true semantics.
     */
    get verified() {
        return this._raw ? this._raw.verified : true;
    }
    get message() {
        return this.raw && this.raw.message || '';
    }
    render(host) {
        this.treeWidget = host;
        const classNames = ['theia-source-breakpoint'];
        if (!this.isEnabled()) {
            classNames.push(browser_1.DISABLED_CLASS);
        }
        const decoration = this.getDecoration();
        return (0, jsx_runtime_1.jsxs)("div", { title: decoration.message.join('\n'), className: classNames.join(' '), children: [(0, jsx_runtime_1.jsx)("span", { className: 'theia-debug-breakpoint-icon codicon ' + decoration.className }), (0, jsx_runtime_1.jsx)("input", { className: 'theia-input', type: 'checkbox', checked: this.origin.enabled, onChange: this.setBreakpointEnabled }), this.doRender()] });
    }
    isEnabled() {
        return this.breakpoints.breakpointsEnabled && this.verified;
    }
    getDecoration() {
        if (!this.enabled) {
            return this.getDisabledBreakpointDecoration();
        }
        if (this.installed && !this.verified) {
            return this.getUnverifiedBreakpointDecoration();
        }
        return this.doGetDecoration();
    }
    getUnverifiedBreakpointDecoration() {
        const decoration = this.getBreakpointDecoration();
        return {
            className: decoration.className + '-unverified',
            message: [this.message || core_1.nls.localize('theia/debug/unverifiedBreakpoint', 'Unverified {0}', decoration.message[0])]
        };
    }
    getDisabledBreakpointDecoration(message) {
        const decoration = this.getBreakpointDecoration();
        return {
            className: decoration.className + '-disabled',
            message: [message || core_1.nls.localize('theia/debug/disabledBreakpoint', 'Disabled {0}', decoration.message[0])]
        };
    }
    doGetDecoration(messages = []) {
        if (this.message) {
            if (messages.length) {
                messages[messages.length - 1].concat(', ' + this.message);
            }
            else {
                messages.push(this.message);
            }
        }
        return this.getBreakpointDecoration(messages);
    }
    async selectInTree() {
        if (this.treeWidget?.model && tree_selection_1.SelectableTreeNode.is(this)) {
            this.treeWidget.model.selectNode(this);
        }
    }
}
exports.DebugBreakpoint = DebugBreakpoint;
//# sourceMappingURL=debug-breakpoint.js.map