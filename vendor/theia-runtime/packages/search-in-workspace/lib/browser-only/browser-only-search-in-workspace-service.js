"use strict";
// *****************************************************************************
// Copyright (C) 2025 Maksim Kachurin and others.
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
exports.BrowserOnlySearchInWorkspaceService = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const search_in_workspace_service_1 = require("../browser/search-in-workspace-service");
let BrowserOnlySearchInWorkspaceService = class BrowserOnlySearchInWorkspaceService extends search_in_workspace_service_1.SearchInWorkspaceService {
    init() {
        super.init();
        if (this.searchServer && typeof this.searchServer.setClient === 'function') {
            this.searchServer.setClient(this);
        }
    }
};
exports.BrowserOnlySearchInWorkspaceService = BrowserOnlySearchInWorkspaceService;
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], BrowserOnlySearchInWorkspaceService.prototype, "init", null);
exports.BrowserOnlySearchInWorkspaceService = BrowserOnlySearchInWorkspaceService = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], BrowserOnlySearchInWorkspaceService);
//# sourceMappingURL=browser-only-search-in-workspace-service.js.map