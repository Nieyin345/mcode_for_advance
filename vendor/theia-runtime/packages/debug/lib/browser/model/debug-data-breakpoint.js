"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DebugDataBreakpoint = void 0;
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
// *****************************************************************************
// Copyright (C) 2025 EclipseSource GmbH and others.
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
const browser_1 = require("@theia/core/lib/browser");
const breakpoint_manager_1 = require("../breakpoint/breakpoint-manager");
const debug_breakpoint_1 = require("./debug-breakpoint");
class DebugDataBreakpoint extends debug_breakpoint_1.DebugBreakpoint {
    static create(origin, options) {
        return new this(origin, options);
    }
    constructor(origin, options) {
        super(breakpoint_manager_1.BreakpointManager.DATA_URI, options);
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
        return this.raw ? !!this.raw.supportsDataBreakpoints : true;
    }
    remove() {
        this.breakpoints.removeDataBreakpoint(this);
    }
    doRender() {
        return (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("span", { className: "line-info theia-data-breakpoint", title: this.origin.info.description, children: [(0, jsx_runtime_1.jsx)("span", { className: "name", children: this.origin.info.description }), (0, jsx_runtime_1.jsx)("span", { className: "theia-TreeNodeInfo theia-access-type", children: this.getAccessType() })] }), this.renderActions()] });
    }
    renderActions() {
        return (0, jsx_runtime_1.jsx)("div", { className: 'theia-debug-breakpoint-actions', children: (0, jsx_runtime_1.jsx)("div", { className: (0, browser_1.codicon)('close', true), title: core_1.nls.localizeByDefault('Remove Breakpoint'), onClick: this.onRemove }) });
    }
    getAccessType() {
        switch (this.origin.raw.accessType) {
            case 'read': return 'Read';
            case 'write': return 'Write';
            default: return 'Access';
        }
    }
    getBreakpointDecoration(message) {
        if (!this.isSupported()) {
            return {
                className: 'codicon-debug-breakpoint-unsupported',
                message: message ?? [core_1.nls.localizeByDefault('Data Breakpoint')],
            };
        }
        if (this.origin.raw.condition || this.origin.raw.hitCondition) {
            return {
                className: 'codicon-debug-breakpoint-conditional',
                message: message || [core_1.nls.localize('theia/debug/conditionalBreakpoint', 'Conditional Breakpoint')]
            };
        }
        return {
            className: 'codicon-debug-breakpoint-data',
            message: message || [core_1.nls.localizeByDefault('Data Breakpoint')]
        };
    }
}
exports.DebugDataBreakpoint = DebugDataBreakpoint;
//# sourceMappingURL=debug-data-breakpoint.js.map