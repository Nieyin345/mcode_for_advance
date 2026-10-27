"use strict";
// *****************************************************************************
// Copyright (C) 2025 EclipseSource GmbH.
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
exports.OpenEditorsVariableContribution = exports.OPEN_EDITORS_SHORT_VARIABLE = exports.OPEN_EDITORS_VARIABLE = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const inversify_1 = require("@theia/core/shared/inversify");
const browser_1 = require("@theia/editor/lib/browser");
const browser_2 = require("@theia/workspace/lib/browser");
exports.OPEN_EDITORS_VARIABLE = {
    id: 'openEditors',
    description: core_1.nls.localize('theia/ai/core/openEditorsVariable/description', 'A comma-separated list of all currently open files as workspace-relative paths (e.g., my-project/src/index.ts).'),
    name: 'openEditors',
};
exports.OPEN_EDITORS_SHORT_VARIABLE = {
    id: 'openEditorsShort',
    description: core_1.nls.localize('theia/ai/core/openEditorsShortVariable/description', 'Short reference to all currently open files (relative paths, comma-separated)'),
    name: '_ff',
};
let OpenEditorsVariableContribution = class OpenEditorsVariableContribution {
    registerVariables(service) {
        service.registerResolver(exports.OPEN_EDITORS_VARIABLE, this);
        service.registerResolver(exports.OPEN_EDITORS_SHORT_VARIABLE, this);
    }
    canResolve(request, _context) {
        return (request.variable.name === exports.OPEN_EDITORS_VARIABLE.name || request.variable.name === exports.OPEN_EDITORS_SHORT_VARIABLE.name) ? 50 : 0;
    }
    async resolve(request, _context) {
        if (request.variable.name !== exports.OPEN_EDITORS_VARIABLE.name && request.variable.name !== exports.OPEN_EDITORS_SHORT_VARIABLE.name) {
            return undefined;
        }
        const openFiles = this.getAllOpenFilesRelative();
        return {
            variable: request.variable,
            value: openFiles
        };
    }
    getAllOpenFilesRelative() {
        const openFiles = [];
        // Get all open editors from the editor manager
        for (const editor of this.editorManager.all) {
            const uri = editor.getResourceUri();
            if (uri) {
                const relativePath = this.getWorkspaceRelativePath(uri);
                if (relativePath) {
                    openFiles.push(`'${relativePath}'`);
                }
            }
        }
        return openFiles.join(', ');
    }
    getWorkspaceRelativePath(uri) {
        return this.workspaceService.getRootPrefixedPath(uri);
    }
};
exports.OpenEditorsVariableContribution = OpenEditorsVariableContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.EditorManager),
    tslib_1.__metadata("design:type", browser_1.EditorManager)
], OpenEditorsVariableContribution.prototype, "editorManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_2.WorkspaceService),
    tslib_1.__metadata("design:type", browser_2.WorkspaceService)
], OpenEditorsVariableContribution.prototype, "workspaceService", void 0);
exports.OpenEditorsVariableContribution = OpenEditorsVariableContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], OpenEditorsVariableContribution);
//# sourceMappingURL=open-editors-variable-contribution.js.map