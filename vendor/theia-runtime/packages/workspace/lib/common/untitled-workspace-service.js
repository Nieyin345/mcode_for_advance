"use strict";
// *****************************************************************************
// Copyright (C) 2018 Ericsson and others.
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
exports.UntitledWorkspaceService = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const workspace_file_service_1 = require("./workspace-file-service");
let UntitledWorkspaceService = class UntitledWorkspaceService {
    /**
     * Check if a URI is an untitled workspace.
     * @param candidate The URI to check
     * @param configDirUri Optional config directory URI. If provided, also verifies
     *                     that the candidate is under the expected workspaces directory.
     *                     This is the secure check and should be used when possible.
     */
    isUntitledWorkspace(candidate, configDirUri) {
        if (!candidate || !this.workspaceFileService.isWorkspaceFile(candidate)) {
            return false;
        }
        if (!candidate.path.base.startsWith('Untitled')) {
            return false;
        }
        // If configDirUri is provided, verify the candidate is in the expected location
        if (configDirUri) {
            const expectedParentDir = configDirUri.resolve('workspaces');
            return expectedParentDir.isEqualOrParent(candidate);
        }
        // Without configDirUri, fall back to name-only check (less secure)
        return true;
    }
    async getUntitledWorkspaceUri(configDirUri, isAcceptable, warnOnHits) {
        const parentDir = configDirUri.resolve('workspaces');
        const workspaceExtensions = this.workspaceFileService.getWorkspaceFileExtensions();
        const defaultFileExtension = workspaceExtensions[this.workspaceFileService.defaultFileTypeIndex];
        let uri;
        let attempts = 0;
        do {
            attempts++;
            uri = parentDir.resolve(`Untitled-${Math.round(Math.random() * 1000)}.${defaultFileExtension}`);
            if (attempts === 10) {
                warnOnHits?.();
            }
            if (attempts === 50) {
                throw new Error('Workspace Service: too many attempts to find unused filename.');
            }
        } while (!(await isAcceptable(uri)));
        return uri;
    }
};
exports.UntitledWorkspaceService = UntitledWorkspaceService;
tslib_1.__decorate([
    (0, inversify_1.inject)(workspace_file_service_1.WorkspaceFileService),
    tslib_1.__metadata("design:type", workspace_file_service_1.WorkspaceFileService)
], UntitledWorkspaceService.prototype, "workspaceFileService", void 0);
exports.UntitledWorkspaceService = UntitledWorkspaceService = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], UntitledWorkspaceService);
//# sourceMappingURL=untitled-workspace-service.js.map