"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DebugFunctionBreakpoint = void 0;
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
// *****************************************************************************
// Copyright (C) 2019 TypeFox and others.
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
const breakpoint_marker_1 = require("../breakpoint/breakpoint-marker");
const breakpoint_manager_1 = require("../breakpoint/breakpoint-manager");
const debug_breakpoint_1 = require("./debug-breakpoint");
const dialogs_1 = require("@theia/core/lib/browser/dialogs");
const core_1 = require("@theia/core");
const browser_1 = require("@theia/core/lib/browser");
class DebugFunctionBreakpoint extends debug_breakpoint_1.DebugBreakpoint {
    static create(origin, options) {
        return new this(origin, options);
    }
    constructor(origin, options) {
        super(breakpoint_manager_1.BreakpointManager.FUNCTION_URI, options);
        this.origin = origin;
        this.onEdit = async () => {
            await this.selectInTree();
            this.open();
        };
        this.onRemove = async () => {
            await this.selectInTree();
            this.remove();
        };
    }
    setEnabled(enabled) {
        this.breakpoints.enableBreakpoint(this, enabled);
    }
    isEnabled() {
        return super.isEnabled() && this.isSupported();
    }
    isSupported() {
        return this.raw ? !!this.raw.supportsFunctionBreakpoints : true;
    }
    remove() {
        this.breakpoints.removeFunctionBreakpoint(this);
    }
    get name() {
        return this.origin.raw.name;
    }
    doRender() {
        return (0, jsx_runtime_1.jsxs)(React.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { className: 'line-info', children: this.name }), this.renderActions()] });
    }
    renderActions() {
        return (0, jsx_runtime_1.jsxs)("div", { className: 'theia-debug-breakpoint-actions', children: [(0, jsx_runtime_1.jsx)("div", { className: (0, browser_1.codicon)('edit', true), title: core_1.nls.localizeByDefault('Edit Condition...'), onClick: this.onEdit }), (0, jsx_runtime_1.jsx)("div", { className: (0, browser_1.codicon)('close', true), title: core_1.nls.localizeByDefault('Remove Breakpoint'), onClick: this.onRemove })] });
    }
    doGetDecoration() {
        if (!this.isSupported()) {
            return this.getDisabledBreakpointDecoration(core_1.nls.localizeByDefault('Function breakpoints are not supported by this debug type'));
        }
        return super.doGetDecoration();
    }
    getBreakpointDecoration(message) {
        return {
            className: 'codicon-debug-breakpoint-function',
            message: message || [core_1.nls.localizeByDefault('Function Breakpoint')]
        };
    }
    static async editOrCreate(breakpoints, existing) {
        const input = new dialogs_1.SingleTextInputDialog({
            title: core_1.nls.localizeByDefault('Add Function Breakpoint'),
            initialValue: existing?.name ?? ''
        });
        const newValue = await input.open();
        if (!newValue) {
            return;
        }
        if (existing) {
            breakpoints.updateFunctionBreakpoint(existing, { name: newValue });
        }
        else {
            breakpoints.addFunctionBreakpoint(breakpoint_marker_1.FunctionBreakpoint.create({ name: newValue }));
        }
    }
    async open() {
        DebugFunctionBreakpoint.editOrCreate(this.breakpoints, this);
    }
}
exports.DebugFunctionBreakpoint = DebugFunctionBreakpoint;
//# sourceMappingURL=debug-function-breakpoint.js.map