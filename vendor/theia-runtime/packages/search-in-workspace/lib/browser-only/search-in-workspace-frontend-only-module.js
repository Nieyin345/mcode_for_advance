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
const inversify_1 = require("@theia/core/shared/inversify");
const search_in_workspace_interface_1 = require("../common/search-in-workspace-interface");
const browser_search_in_workspace_server_1 = require("./browser-search-in-workspace-server");
const search_in_workspace_service_1 = require("../browser/search-in-workspace-service");
const browser_only_search_in_workspace_service_1 = require("./browser-only-search-in-workspace-service");
exports.default = new inversify_1.ContainerModule((bind, _unbind, isBound, rebind) => {
    if (isBound(search_in_workspace_interface_1.SearchInWorkspaceServer)) {
        rebind(search_in_workspace_interface_1.SearchInWorkspaceServer).to(browser_search_in_workspace_server_1.BrowserSearchInWorkspaceServer).inSingletonScope();
    }
    else {
        bind(search_in_workspace_interface_1.SearchInWorkspaceServer).to(browser_search_in_workspace_server_1.BrowserSearchInWorkspaceServer).inSingletonScope();
    }
    if (isBound(search_in_workspace_service_1.SearchInWorkspaceService)) {
        rebind(search_in_workspace_service_1.SearchInWorkspaceService).to(browser_only_search_in_workspace_service_1.BrowserOnlySearchInWorkspaceService).inSingletonScope();
    }
    else {
        bind(search_in_workspace_service_1.SearchInWorkspaceService).to(browser_only_search_in_workspace_service_1.BrowserOnlySearchInWorkspaceService).inSingletonScope();
    }
});
//# sourceMappingURL=search-in-workspace-frontend-only-module.js.map