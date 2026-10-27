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
exports.InstallMcpUriHandler = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const dialogs_1 = require("@theia/core/lib/browser/dialogs");
const window_service_1 = require("@theia/core/lib/browser/window/window-service");
const inversify_1 = require("@theia/core/shared/inversify");
const mcp_preferences_1 = require("../common/mcp-preferences");
const mcp_server_editor_1 = require("./mcp-server-editor");
const mcp_install_uri_configuration_1 = require("./mcp-install-uri-configuration");
const mcp_registry_ui_bridge_1 = require("./mcp-registry-ui-bridge");
const mcp_server_install_dialog_1 = require("./mcp-server-install-dialog");
const ID_PARAM = 'id';
/**
 * Handles `theia://install-mcp?id=<serverId>` deep links. The URL is intentionally
 * minimal: the install configuration, version, display name and content hash are all
 * read from the configured AI registry by id. This guarantees the user installs exactly
 * what the registry currently publishes and keeps install links short and stable.
 *
 * Opening such a link brings the IDE window to the foreground, reveals the AI registry
 * (Extensions) view with the `serverId` searched so the entry is in focus, and then opens
 * the install dialog for that entry.
 *
 * Lives in `@theia/ai-mcp` so products without the registry package still receive the
 * URL - but installation only succeeds when an `MCPRegistryUiBridge` is bound and the
 * id exists in the registry. The bridge is consulted via `@optional()`.
 */
let InstallMcpUriHandler = class InstallMcpUriHandler {
    constructor() {
        this.id = 'install-mcp-uri-handler';
    }
    canHandle(uri) {
        // Validate both scheme (must match the product's electron URI scheme) and authority
        // so we don't accidentally claim URIs from unrelated protocols.
        return uri.scheme === this.configuration.getScheme()
            && uri.authority === this.configuration.getAuthority()
            ? 500
            : 0;
    }
    async open(uri) {
        const serverId = this.extractServerId(uri);
        this.windowService.focus();
        if (!serverId) {
            this.messageService.error(core_1.nls.localize('theia/ai-mcp/installUri/missingId', 'Install link is missing the required "id" parameter.'));
            return undefined;
        }
        if (!this.registryBridge) {
            this.messageService.error(core_1.nls.localize('theia/ai-mcp/installUri/noRegistry', 'Cannot install MCP server "{0}" - no AI registry is configured in this product.', serverId));
            return undefined;
        }
        // Wait for the bridge's first fetch so an id click immediately after startup
        // doesn't race the registry load and produce a false "not found".
        await this.registryBridge.ready();
        const entry = this.registryBridge.getInstallEntry(serverId);
        if (!entry) {
            this.messageService.error(core_1.nls.localize('theia/ai-mcp/installUri/unknownId', 'MCP server "{0}" is not listed in your AI registry.', serverId));
            return undefined;
        }
        await this.registryBridge.openRegistry(serverId);
        if (this.isAlreadyInstalled(entry.localName) && !await this.confirmOverwrite(entry.localName)) {
            return undefined;
        }
        const dialog = this.installDialogFactory({
            name: entry.localName,
            autostart: true,
            requireAuthToken: 'serverAuthToken' in entry.config,
            requireOAuth: 'oauth' in entry.config,
            // Bridge already resolved this id, so trust is always "verified" here.
            trust: { status: 'verified', serverId }
        });
        const result = await dialog.open();
        if (!result) {
            return undefined;
        }
        await this.editor.installFromEntry(entry, result);
        // Deep-link installs may originate from a browser tab the user has since switched
        // away from; close success can otherwise be silent because the dialog dismisses on
        // confirm. A confirmation toast makes the outcome explicit.
        this.messageService.info(core_1.nls.localize('theia/ai-mcp/installUri/success', 'Installed MCP server "{0}" from the AI registry.', entry.localName));
        return undefined;
    }
    /** True if a server with this name is already in `ai-features.mcp.mcpServers`. */
    isAlreadyInstalled(localName) {
        const stored = this.preferenceService.get(mcp_preferences_1.MCP_SERVERS_PREF, {}) ?? {};
        return Object.prototype.hasOwnProperty.call(stored, localName);
    }
    /**
     * Acknowledge prompt for already-installed servers. We don't try to be clever about
     * "is this the same registry entry?" - the user may have edited the local config
     * and any overwrite should be an explicit decision.
     */
    async confirmOverwrite(localName) {
        const dialog = new dialogs_1.ConfirmDialog({
            title: core_1.nls.localize('theia/ai-mcp/installUri/alreadyInstalled/title', 'MCP server already installed'),
            msg: core_1.nls.localize('theia/ai-mcp/installUri/alreadyInstalled/msg', 'An MCP server named "{0}" is already configured. Continuing will overwrite the existing entry with the configuration from the registry.', localName),
            ok: core_1.nls.localizeByDefault('Continue'),
            cancel: core_1.nls.localizeByDefault('Cancel')
        });
        return !!await dialog.open();
    }
    extractServerId(uri) {
        return new URLSearchParams(uri.query).get(ID_PARAM)?.trim() || undefined;
    }
};
exports.InstallMcpUriHandler = InstallMcpUriHandler;
tslib_1.__decorate([
    (0, inversify_1.inject)(mcp_install_uri_configuration_1.MCPInstallUriConfiguration),
    tslib_1.__metadata("design:type", mcp_install_uri_configuration_1.MCPInstallUriConfiguration)
], InstallMcpUriHandler.prototype, "configuration", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(mcp_server_editor_1.MCPServerEditor),
    tslib_1.__metadata("design:type", Object)
], InstallMcpUriHandler.prototype, "editor", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.MessageService),
    tslib_1.__metadata("design:type", core_1.MessageService)
], InstallMcpUriHandler.prototype, "messageService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(window_service_1.WindowService),
    tslib_1.__metadata("design:type", Object)
], InstallMcpUriHandler.prototype, "windowService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.PreferenceService),
    tslib_1.__metadata("design:type", Object)
], InstallMcpUriHandler.prototype, "preferenceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(mcp_registry_ui_bridge_1.MCPRegistryUiBridge),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], InstallMcpUriHandler.prototype, "registryBridge", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(mcp_server_install_dialog_1.MCPServerInstallDialogFactory),
    tslib_1.__metadata("design:type", Function)
], InstallMcpUriHandler.prototype, "installDialogFactory", void 0);
exports.InstallMcpUriHandler = InstallMcpUriHandler = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], InstallMcpUriHandler);
//# sourceMappingURL=install-mcp-uri-handler.js.map