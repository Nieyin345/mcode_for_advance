"use strict";
/********************************************************************************
 * Copyright (C) 2022 TypeFox and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
 ********************************************************************************/
Object.defineProperty(exports, "__esModule", { value: true });
exports.ElectronBackendRequestService = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("inversify");
const node_request_service_1 = require("@theia/request/lib/node-request-service");
const electron_token_1 = require("../../electron-common/electron-token");
const common_1 = require("../../common");
(0, inversify_1.decorate)((0, inversify_1.injectable)(), node_request_service_1.NodeRequestService);
let ElectronBackendRequestService = class ElectronBackendRequestService extends node_request_service_1.NodeRequestService {
    async getProxyUrl(url) {
        if (this.proxyUrl) {
            return this.proxyUrl;
        }
        try {
            const proxy = await this.resolveProxy(url);
            if (proxy && proxy !== 'DIRECT') {
                const proxyHost = proxy.split(' ')[1];
                return this.buildProxyUrl(url, proxyHost);
            }
        }
        catch (e) {
            this.logger.error('Could not resolve electron proxy.', e);
        }
        return super.getProxyUrl(url);
    }
    async resolveProxy(url) {
        // TODO: Implement IPC to the backend to access the Electron proxy resolver
        return undefined;
    }
    buildProxyUrl(url, proxyHost) {
        if (proxyHost.startsWith('http://') || proxyHost.startsWith('https://')) {
            return proxyHost;
        }
        if (url.startsWith('http://')) {
            return 'http://' + proxyHost;
        }
        else if (url.startsWith('https://')) {
            return 'https://' + proxyHost;
        }
        return proxyHost;
    }
    async processOptions(options) {
        options = await super.processOptions(options);
        const endpoint = new URL(options.url);
        if (endpoint.hostname === 'localhost') {
            const securityToken = process.env[electron_token_1.ElectronSecurityToken];
            if (securityToken) {
                let cookie = options.headers?.['Cookie'] ?? '';
                if (cookie) {
                    cookie += '; ';
                }
                cookie += `${electron_token_1.ElectronSecurityToken}=${securityToken}`;
                options.headers = {
                    ...(options.headers || {}),
                    'Cookie': cookie
                };
            }
        }
        return options;
    }
};
exports.ElectronBackendRequestService = ElectronBackendRequestService;
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.ILogger),
    (0, inversify_1.named)('core:ElectronBackendRequestService'),
    tslib_1.__metadata("design:type", Object)
], ElectronBackendRequestService.prototype, "logger", void 0);
exports.ElectronBackendRequestService = ElectronBackendRequestService = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], ElectronBackendRequestService);
//# sourceMappingURL=electron-backend-request-service.js.map