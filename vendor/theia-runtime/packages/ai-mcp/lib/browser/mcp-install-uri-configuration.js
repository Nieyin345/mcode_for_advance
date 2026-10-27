"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource GmbH.
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
exports.MCPInstallUriConfiguration = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const frontend_application_config_provider_1 = require("@theia/core/lib/browser/frontend-application-config-provider");
/**
 * Configuration for the `install-mcp` deep-link URL handler.
 *
 * Defaults to `<electron-uri-scheme>://install-mcp` - products override by rebinding
 * this class in their frontend module. The same scheme/authority is used by the
 * registry maintainer when generating per-entry install URLs in the registry JSON, so
 * that a click on such a link is routed to Theia and dispatched to this package's
 * `InstallMcpUriHandler`.
 */
let MCPInstallUriConfiguration = class MCPInstallUriConfiguration {
    /**
     * Scheme of the install URL - must match the product's Electron protocol
     * registration (see `theia.frontend.config.electron.uriScheme` in `package.json`).
     */
    getScheme() {
        return frontend_application_config_provider_1.FrontendApplicationConfigProvider.get().electron?.uriScheme ?? 'theia';
    }
    /** URL authority that identifies install-mcp links. */
    getAuthority() {
        return 'install-mcp';
    }
};
exports.MCPInstallUriConfiguration = MCPInstallUriConfiguration;
exports.MCPInstallUriConfiguration = MCPInstallUriConfiguration = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MCPInstallUriConfiguration);
//# sourceMappingURL=mcp-install-uri-configuration.js.map