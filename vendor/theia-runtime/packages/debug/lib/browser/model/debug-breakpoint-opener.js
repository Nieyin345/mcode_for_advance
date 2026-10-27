"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource GmbH and others.
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DebugBreakpointOpener = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const browser_1 = require("@theia/editor/lib/browser");
const breakpoint_manager_1 = require("../breakpoint/breakpoint-manager");
const debug_session_manager_1 = require("../debug-session-manager");
const breakpoint_marker_1 = require("../breakpoint/breakpoint-marker");
let DebugBreakpointOpener = class DebugBreakpointOpener {
    constructor() {
        this.id = 'debug-breakpoint-opener';
    }
    canHandle(uri, options) {
        return uri.scheme === breakpoint_marker_1.DEBUG_BREAKPOINT_SCHEME ? 150 : -1;
    }
    open(uri, options) {
        if (uri.scheme !== breakpoint_marker_1.DEBUG_BREAKPOINT_SCHEME) {
            throw new Error(`Unexpected scheme. Expected '${breakpoint_marker_1.DEBUG_BREAKPOINT_SCHEME}' but got '${uri.scheme}'.`);
        }
        const bpId = uri.authority;
        const bp = this.breakpointManager.getBreakpointById(bpId);
        if (!bp) {
            return;
        }
        if (bp.raw?.source) {
            const session = this.sessionManager.getSession(bp.raw.sessionId);
            const source = session?.getSource(bp.raw.source);
            if (source) {
                return source.open(options);
            }
        }
        return this.editorManager.open(bp.uri, options);
    }
};
exports.DebugBreakpointOpener = DebugBreakpointOpener;
tslib_1.__decorate([
    (0, inversify_1.inject)(breakpoint_manager_1.BreakpointManager),
    tslib_1.__metadata("design:type", breakpoint_manager_1.BreakpointManager)
], DebugBreakpointOpener.prototype, "breakpointManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_session_manager_1.DebugSessionManager),
    tslib_1.__metadata("design:type", debug_session_manager_1.DebugSessionManager)
], DebugBreakpointOpener.prototype, "sessionManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.EditorManager),
    tslib_1.__metadata("design:type", browser_1.EditorManager)
], DebugBreakpointOpener.prototype, "editorManager", void 0);
exports.DebugBreakpointOpener = DebugBreakpointOpener = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], DebugBreakpointOpener);
//# sourceMappingURL=debug-breakpoint-opener.js.map