"use strict";
// *****************************************************************************
// Copyright (C) 2025 1C-Soft LLC and others.
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
exports.MonacoWorkspaceContextService = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const event_1 = require("@theia/monaco-editor-core/esm/vs/base/common/event");
const workspace_1 = require("@theia/monaco-editor-core/esm/vs/platform/workspace/common/workspace");
/**
 * A minimal implementation of {@link IWorkspaceContextService} to replace the `StandaloneWorkspaceContextService` in Monaco
 * as a workaround for the issue of showing no context menu for editor minimap (#15217).
 */
let MonacoWorkspaceContextService = class MonacoWorkspaceContextService {
    constructor() {
        this.onDidChangeWorkbenchStateEmitter = new event_1.Emitter();
        this.onDidChangeWorkbenchState = this.onDidChangeWorkbenchStateEmitter.event;
        this.onDidChangeWorkspaceNameEmitter = new event_1.Emitter();
        this.onDidChangeWorkspaceName = this.onDidChangeWorkspaceNameEmitter.event;
        this.onWillChangeWorkspaceFoldersEmitter = new event_1.Emitter();
        this.onWillChangeWorkspaceFolders = this.onWillChangeWorkspaceFoldersEmitter.event;
        this.onDidChangeWorkspaceFoldersEmitter = new event_1.Emitter();
        this.onDidChangeWorkspaceFolders = this.onDidChangeWorkspaceFoldersEmitter.event;
        this.workspace = { id: workspace_1.UNKNOWN_EMPTY_WINDOW_WORKSPACE.id, folders: [] };
    }
    getCompleteWorkspace() {
        return Promise.resolve(this.getWorkspace());
    }
    getWorkspace() {
        return this.workspace;
    }
    getWorkbenchState() {
        return 1 /* WorkbenchState.EMPTY */;
    }
    getWorkspaceFolder(resource) {
        // eslint-disable-next-line no-null/no-null
        return null;
    }
    isCurrentWorkspace(workspaceIdOrFolder) {
        return false;
    }
    isInsideWorkspace(resource) {
        return false;
    }
};
exports.MonacoWorkspaceContextService = MonacoWorkspaceContextService;
exports.MonacoWorkspaceContextService = MonacoWorkspaceContextService = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MonacoWorkspaceContextService);
//# sourceMappingURL=monaco-workspace-context-service.js.map