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
exports.WorkspaceSearchFilterService = exports.WorkspaceSearchFilterProvider = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const inversify_1 = require("@theia/core/shared/inversify");
exports.WorkspaceSearchFilterProvider = Symbol('WorkspaceSearchFilterProvider');
/**
 * A service providing workspace search filters to clients performing searches over files in the
 * workspace. Clients may use these filters in whatever way makes most sense for them.
 */
let WorkspaceSearchFilterService = class WorkspaceSearchFilterService {
    constructor() {
        this.onExclusionGlobsChangedEmitter = new core_1.Emitter();
        /** An event signalling when the exclusion globs provided by this provider have changed. */
        this.onExclusionGlobsChanged = this.onExclusionGlobsChangedEmitter.event;
    }
    init() {
        for (const provider of this.providers.getContributions()) {
            provider.onExclusionGlobsChanged(() => {
                this.exclusionGlobs = undefined;
                this.onExclusionGlobsChangedEmitter.fire();
            });
        }
    }
    /**
     * Obtain zero or more glob patterns matching files to exclude from searches in the workspace.
     */
    getExclusionGlobs() {
        if (this.exclusionGlobs === undefined) {
            const globs = new Set();
            for (const provider of this.providers.getContributions()) {
                for (const glob of provider.getExclusionGlobs()) {
                    globs.add(glob);
                }
            }
            this.exclusionGlobs = [...globs];
        }
        return this.exclusionGlobs;
    }
};
exports.WorkspaceSearchFilterService = WorkspaceSearchFilterService;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ContributionProvider),
    (0, inversify_1.named)(exports.WorkspaceSearchFilterProvider),
    tslib_1.__metadata("design:type", Object)
], WorkspaceSearchFilterService.prototype, "providers", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], WorkspaceSearchFilterService.prototype, "init", null);
exports.WorkspaceSearchFilterService = WorkspaceSearchFilterService = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], WorkspaceSearchFilterService);
//# sourceMappingURL=workspace-search-filter-service.js.map