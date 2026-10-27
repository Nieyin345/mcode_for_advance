"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource and others.
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
exports.WorkspaceFilesExcludeFilterProvider = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const inversify_1 = require("@theia/core/shared/inversify");
const common_1 = require("@theia/filesystem/lib/common");
/**
 * A workspace search filter provider that contributes the user-configurable
 * "Files: Exclude" settings from the preferences.
 */
let WorkspaceFilesExcludeFilterProvider = class WorkspaceFilesExcludeFilterProvider {
    constructor() {
        this.onExclusionGlobsChangedEmitter = new core_1.Emitter();
        this.onExclusionGlobsChanged = this.onExclusionGlobsChangedEmitter.event;
    }
    init() {
        this.fsPreferences.onPreferenceChanged(e => {
            if (e.preferenceName === 'files.exclude') {
                this.onExclusionGlobsChangedEmitter.fire();
            }
        });
    }
    getExclusionGlobs() {
        const filesExclude = this.fsPreferences['files.exclude'];
        return Object.keys(filesExclude).filter(key => !!filesExclude[key]);
    }
};
exports.WorkspaceFilesExcludeFilterProvider = WorkspaceFilesExcludeFilterProvider;
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.FileSystemPreferences),
    tslib_1.__metadata("design:type", Object)
], WorkspaceFilesExcludeFilterProvider.prototype, "fsPreferences", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], WorkspaceFilesExcludeFilterProvider.prototype, "init", null);
exports.WorkspaceFilesExcludeFilterProvider = WorkspaceFilesExcludeFilterProvider = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], WorkspaceFilesExcludeFilterProvider);
//# sourceMappingURL=workspace-files-exclude-filter-provider.js.map