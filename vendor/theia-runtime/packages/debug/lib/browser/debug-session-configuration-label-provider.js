"use strict";
// *****************************************************************************
// Copyright (C) 2025 and others.
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
exports.DebugSessionConfigurationLabelProvider = void 0;
const tslib_1 = require("tslib");
const uri_1 = require("@theia/core/lib/common/uri");
const inversify_1 = require("@theia/core/shared/inversify");
const browser_1 = require("@theia/workspace/lib/browser");
/**
 * Provides a label for the debug session without the need to create the session.
 * Debug session labels are used to check if sessions are the "same".
 */
let DebugSessionConfigurationLabelProvider = class DebugSessionConfigurationLabelProvider {
    // https://github.com/microsoft/vscode/blob/907518a25c6d6b9467cbcc57132c6adb7e7396b0/src/vs/workbench/contrib/debug/browser/debugSession.ts#L253-L256
    getLabel(params, includeRoot = this.workspaceService.tryGetRoots().length > 1) {
        let { name, workspaceFolderUri } = params;
        if (includeRoot && workspaceFolderUri) {
            const uri = new uri_1.default(workspaceFolderUri);
            const path = uri.path;
            const basenameOrAuthority = path.name || uri.authority;
            name += ` (${basenameOrAuthority})`;
        }
        return name;
    }
};
exports.DebugSessionConfigurationLabelProvider = DebugSessionConfigurationLabelProvider;
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.WorkspaceService),
    tslib_1.__metadata("design:type", browser_1.WorkspaceService)
], DebugSessionConfigurationLabelProvider.prototype, "workspaceService", void 0);
exports.DebugSessionConfigurationLabelProvider = DebugSessionConfigurationLabelProvider = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], DebugSessionConfigurationLabelProvider);
//# sourceMappingURL=debug-session-configuration-label-provider.js.map