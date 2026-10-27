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
exports.MCPOAuthFrontendDelegateClientImpl = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const endpoint_1 = require("@theia/core/lib/browser/endpoint");
const window_service_1 = require("@theia/core/lib/browser/window/window-service");
const inversify_1 = require("@theia/core/shared/inversify");
const mcp_oauth_1 = require("../common/mcp-oauth");
const mcp_server_manager_1 = require("../common/mcp-server-manager");
let MCPOAuthFrontendDelegateClientImpl = class MCPOAuthFrontendDelegateClientImpl {
    init() {
        // A server update means the OAuth flow progressed, so the notification is stale.
        this.mcpNotificationService.onDidUpdateMCPServers(() => {
            this.pendingBrowserPrompt?.cancel();
            this.pendingBrowserPrompt = undefined;
        });
    }
    async openExternal(url) {
        this.windowService.openNewWindow(url, { external: true });
        // Popup blockers may suppress the window.open above without indication, as the RPC round-trip
        // consumed the user activation of the original click. The notification's 'Open' action carries
        // fresh activation as a manual fallback; not awaited so the flow proceeds to the callback wait.
        this.pendingBrowserPrompt?.cancel();
        const openAction = core_1.nls.localizeByDefault('Open');
        this.messageService.showProgress({
            text: core_1.nls.localize('theia/ai/mcp/oauth/completeSignInInBrowser', 'Complete the MCP OAuth sign-in in your browser. If no sign-in tab opened, your browser may have blocked the popup.'),
            actions: [openAction],
            options: { cancelable: true }
        }).then(progress => {
            this.pendingBrowserPrompt = progress;
            return progress.result.then(action => {
                if (this.pendingBrowserPrompt === progress) {
                    this.pendingBrowserPrompt = undefined;
                }
                if (action === openAction) {
                    this.windowService.openNewWindow(url, { external: true });
                }
            });
        }).catch(error => {
            this.logger.error('Failed to drive the MCP OAuth browser sign-in toast', error);
        });
    }
    async getCallbackUrl() {
        const callbackUrl = new endpoint_1.Endpoint({ path: mcp_oauth_1.MCP_OAUTH_CALLBACK_PATH }).getRestUrl().toString();
        this.logger.debug(`Computed MCP OAuth callback URL: ${callbackUrl}`);
        return callbackUrl;
    }
};
exports.MCPOAuthFrontendDelegateClientImpl = MCPOAuthFrontendDelegateClientImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(window_service_1.WindowService),
    tslib_1.__metadata("design:type", Object)
], MCPOAuthFrontendDelegateClientImpl.prototype, "windowService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.MessageService),
    tslib_1.__metadata("design:type", core_1.MessageService)
], MCPOAuthFrontendDelegateClientImpl.prototype, "messageService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(mcp_server_manager_1.MCPFrontendNotificationService),
    tslib_1.__metadata("design:type", Object)
], MCPOAuthFrontendDelegateClientImpl.prototype, "mcpNotificationService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('ai-mcp:MCPOAuthFrontendDelegateClientImpl'),
    tslib_1.__metadata("design:type", Object)
], MCPOAuthFrontendDelegateClientImpl.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], MCPOAuthFrontendDelegateClientImpl.prototype, "init", null);
exports.MCPOAuthFrontendDelegateClientImpl = MCPOAuthFrontendDelegateClientImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MCPOAuthFrontendDelegateClientImpl);
//# sourceMappingURL=mcp-oauth-frontend-delegate-client.js.map