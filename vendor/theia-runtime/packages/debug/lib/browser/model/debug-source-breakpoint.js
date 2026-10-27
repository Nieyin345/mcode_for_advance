"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DebugSourceBreakpoint = void 0;
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
// *****************************************************************************
// Copyright (C) 2018 TypeFox and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************
const React = require("@theia/core/shared/react");
const core_1 = require("@theia/core");
const uri_1 = require("@theia/core/lib/common/uri");
const browser_1 = require("@theia/core/lib/browser");
const breakpoint_marker_1 = require("../breakpoint/breakpoint-marker");
const debug_breakpoint_1 = require("./debug-breakpoint");
const debug_commands_1 = require("../debug-commands");
class DebugSourceBreakpoint extends debug_breakpoint_1.DebugBreakpoint {
    static create(origin, options) {
        return new this(origin, options);
    }
    constructor(origin, options) {
        super(new uri_1.default(origin.uri), options);
        this.origin = origin;
        this.setBreakpointEnabled = (event) => {
            this.setEnabled(event.target.checked);
        };
        this.onEdit = async () => {
            await this.selectInTree();
            this.commandService.executeCommand(debug_commands_1.DebugCommands.EDIT_BREAKPOINT.id, this);
        };
        this.onRemove = async () => {
            await this.selectInTree();
            this.remove();
        };
    }
    setEnabled(enabled) {
        this.breakpoints.enableBreakpoint(this, enabled);
    }
    /** 1-based */
    get line() {
        return this.raw && this.raw.line || this.origin.raw.line;
    }
    get column() {
        return this.raw && this.raw.column || this.origin.raw.column;
    }
    get endLine() {
        return this.raw && this.raw.endLine;
    }
    get endColumn() {
        return this.raw && this.raw.endColumn;
    }
    get condition() {
        return this.origin.raw.condition;
    }
    get hitCondition() {
        return this.origin.raw.hitCondition;
    }
    get logMessage() {
        return this.origin.raw.logMessage;
    }
    get source() {
        return this.raw?.source;
    }
    async open(options = {
        mode: 'reveal'
    }) {
        const { line, column, endLine, endColumn } = this;
        const selection = {
            start: {
                line: line - 1,
                character: typeof column === 'number' ? column - 1 : undefined
            }
        };
        if (typeof endLine === 'number') {
            selection.end = {
                line: endLine - 1,
                character: typeof endColumn === 'number' ? endColumn - 1 : undefined
            };
        }
        return (0, browser_1.open)(this.openerService, uri_1.default.fromComponents({ authority: this.id, scheme: breakpoint_marker_1.DEBUG_BREAKPOINT_SCHEME, path: '', fragment: '', query: '' }), { ...options, selection });
    }
    doRender() {
        return (0, jsx_runtime_1.jsxs)(React.Fragment, { children: [(0, jsx_runtime_1.jsxs)("span", { className: 'line-info', title: this.labelProvider.getLongName(this.uri), children: [(0, jsx_runtime_1.jsxs)("span", { className: 'name', children: [this.labelProvider.getName(this.uri), " "] }), (0, jsx_runtime_1.jsxs)("span", { className: 'path ' + browser_1.TREE_NODE_INFO_CLASS, children: [this.labelProvider.getLongName(this.uri.parent), " "] })] }), this.renderActions(), (0, jsx_runtime_1.jsx)("span", { className: 'line', children: this.renderPosition() })] });
    }
    renderActions() {
        return (0, jsx_runtime_1.jsxs)("div", { className: 'theia-debug-breakpoint-actions', children: [(0, jsx_runtime_1.jsx)("div", { className: (0, browser_1.codicon)('edit', true), title: core_1.nls.localizeByDefault('Edit Breakpoint'), onClick: this.onEdit }), (0, jsx_runtime_1.jsx)("div", { className: (0, browser_1.codicon)('close', true), title: core_1.nls.localizeByDefault('Remove Breakpoint'), onClick: this.onRemove })] });
    }
    renderPosition() {
        return this.line + (typeof this.column === 'number' ? ':' + this.column : '');
    }
    doGetDecoration(messages = []) {
        if (this.logMessage || this.condition || this.hitCondition) {
            if (this.logMessage) {
                if (this.raw && !this.raw.supportsLogPoints) {
                    return this.getUnsupportedBreakpointDecoration(core_1.nls.localize('theia/debug/logpointsNotSupported', 'Logpoints not supported by this debug type'));
                }
                messages.push(core_1.nls.localizeByDefault('Log Message: {0}', this.logMessage));
            }
            if (this.condition) {
                if (this.raw && !this.raw.supportsConditionalBreakpoints) {
                    return this.getUnsupportedBreakpointDecoration(core_1.nls.localize('theia/debug/conditionalBreakpointsNotSupported', 'Conditional breakpoints not supported by this debug type'));
                }
                messages.push(core_1.nls.localizeByDefault('Condition: {0}', this.condition));
            }
            if (this.hitCondition) {
                if (this.raw && !this.raw.supportsHitConditionalBreakpoints) {
                    return this.getUnsupportedBreakpointDecoration(core_1.nls.localize('theia/debug/htiConditionalBreakpointsNotSupported', 'Hit conditional breakpoints not supported by this debug type'));
                }
                messages.push(core_1.nls.localizeByDefault('Hit Count: {0}', this.hitCondition));
            }
        }
        return super.doGetDecoration(messages);
    }
    getUnsupportedBreakpointDecoration(message) {
        return {
            className: 'codicon-debug-breakpoint-unsupported',
            message: [message]
        };
    }
    getBreakpointDecoration(message) {
        if (this.logMessage) {
            return {
                className: 'codicon-debug-breakpoint-log',
                message: message || [core_1.nls.localizeByDefault('Logpoint')]
            };
        }
        if (this.condition || this.hitCondition) {
            return {
                className: 'codicon-debug-breakpoint-conditional',
                message: message || [core_1.nls.localize('theia/debug/conditionalBreakpoint', 'Conditional Breakpoint')]
            };
        }
        return {
            className: 'codicon-debug-breakpoint',
            message: message || [core_1.nls.localizeByDefault('Breakpoint')]
        };
    }
    remove() {
        this.breakpoints.removeBreakpoint(this);
    }
}
exports.DebugSourceBreakpoint = DebugSourceBreakpoint;
//# sourceMappingURL=debug-source-breakpoint.js.map