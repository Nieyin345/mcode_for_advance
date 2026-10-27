"use strict";
// *****************************************************************************
// Copyright (C) 2026 Daniel Muñoz and others.
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
exports.ElectronWorkspaceContribution = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
require("@theia/core/lib/electron-common/electron-api");
const inversify_1 = require("@theia/core/shared/inversify");
const workspace_service_1 = require("../browser/workspace-service");
let ElectronWorkspaceContribution = class ElectronWorkspaceContribution {
    onStart() {
        this.workspaceService.onWorkspaceChanged(async () => {
            // With the current WorkspaceService implementation, if we await for the ready signal before
            // installing the listener, we miss the first event (the one that we actually want!).
            await this.workspaceService.ready;
            const recent = await this.workspaceService.recentWorkspaces();
            window.electronTheiaCore.updateRecentWorkspaces(recent, core_1.nls.localize('theia/core/jumpListName', 'Recent Workspaces'));
        });
    }
};
exports.ElectronWorkspaceContribution = ElectronWorkspaceContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(workspace_service_1.WorkspaceService),
    tslib_1.__metadata("design:type", workspace_service_1.WorkspaceService)
], ElectronWorkspaceContribution.prototype, "workspaceService", void 0);
exports.ElectronWorkspaceContribution = ElectronWorkspaceContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], ElectronWorkspaceContribution);
//# sourceMappingURL=electron-workspace-contribution.js.map