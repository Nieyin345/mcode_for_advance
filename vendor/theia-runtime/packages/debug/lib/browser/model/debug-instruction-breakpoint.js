"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DebugInstructionBreakpoint = void 0;
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
// *****************************************************************************
// Copyright (C) 2022 Ericsson and others.
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
const core_1 = require("@theia/core");
const React = require("@theia/core/shared/react");
const browser_1 = require("@theia/core/lib/browser");
const breakpoint_manager_1 = require("../breakpoint/breakpoint-manager");
const debug_breakpoint_1 = require("./debug-breakpoint");
class DebugInstructionBreakpoint extends debug_breakpoint_1.DebugBreakpoint {
    static create(origin, options) {
        return new this(origin, options);
    }
    constructor(origin, options) {
        super(breakpoint_manager_1.BreakpointManager.INSTRUCTION_URI, options);
        this.origin = origin;
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
        return this.raw ? !!this.raw.supportsInstructionBreakpoints : true;
    }
    remove() {
        this.breakpoints.removeInstructionBreakpoint(this);
    }
    doRender() {
        return (0, jsx_runtime_1.jsxs)(React.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { className: "line-info", children: this.origin.raw.instructionReference }), this.renderActions()] });
    }
    renderActions() {
        return (0, jsx_runtime_1.jsx)("div", { className: 'theia-debug-breakpoint-actions', children: (0, jsx_runtime_1.jsx)("div", { className: (0, browser_1.codicon)('close', true), title: core_1.nls.localizeByDefault('Remove Breakpoint'), onClick: this.onRemove }) });
    }
    getBreakpointDecoration(message) {
        if (!this.isSupported()) {
            return {
                className: 'codicon-debug-breakpoint-unsupported',
                message: message ?? [core_1.nls.localize('theia/debug/instruction-breakpoint', 'Instruction Breakpoint')],
            };
        }
        if (this.origin.raw.condition || this.origin.raw.hitCondition) {
            return {
                className: 'codicon-debug-breakpoint-conditional',
                message: message || [core_1.nls.localize('theia/debug/conditionalBreakpoint', 'Conditional Breakpoint')]
            };
        }
        return {
            className: 'codicon-debug-breakpoint',
            message: message || [core_1.nls.localize('theia/debug/instruction-breakpoint', 'Instruction Breakpoint')]
        };
    }
}
exports.DebugInstructionBreakpoint = DebugInstructionBreakpoint;
//# sourceMappingURL=debug-instruction-breakpoint.js.map