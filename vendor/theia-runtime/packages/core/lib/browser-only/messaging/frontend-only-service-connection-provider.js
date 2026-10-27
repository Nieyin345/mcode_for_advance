"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FrontendOnlyServiceConnectionProvider = exports.FrontendOnlyRpcProxyFactory = exports.FrontendOnlyConnectionSource = void 0;
const tslib_1 = require("tslib");
// *****************************************************************************
// Copyright (C) 2023 EclipseSource and others.
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
const event_1 = require("../../common/event");
const proxy_factory_1 = require("../../common/messaging/proxy-factory");
const inversify_1 = require("inversify");
const service_connection_provider_1 = require("../../browser/messaging/service-connection-provider");
const logger_1 = require("../../common/logger");
let FrontendOnlyConnectionSource = class FrontendOnlyConnectionSource {
    constructor() {
        this.onConnectionDidOpen = new event_1.Emitter().event;
    }
};
exports.FrontendOnlyConnectionSource = FrontendOnlyConnectionSource;
exports.FrontendOnlyConnectionSource = FrontendOnlyConnectionSource = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], FrontendOnlyConnectionSource);
/**
 * Proxy factory for services without a frontend-only implementation. There is no backend,
 * so no channel will ever open and requests would otherwise be queued forever, blocking
 * any caller that awaits the result, e.g. during application startup.
 * Instead, requests fail immediately and notifications (fire-and-forget) resolve silently.
 */
class FrontendOnlyRpcProxyFactory extends proxy_factory_1.RpcProxyFactory {
    constructor(path, target) {
        super(target);
        this.path = path;
    }
    get(target, p, receiver) {
        if (typeof p !== 'string') {
            return undefined;
        }
        // members handled by the base proxy without a connection
        if (['setClient', 'getClient', 'onDidOpenConnection', 'onDidCloseConnection', 'then', 'toJSON'].includes(p)) {
            return super.get(target, p, receiver);
        }
        if (this.isNotification(p)) {
            return () => Promise.resolve();
        }
        return () => Promise.reject(new Error(`Request '${p}' on service '${this.path}' is unavailable: no backend in frontend-only mode.`));
    }
}
exports.FrontendOnlyRpcProxyFactory = FrontendOnlyRpcProxyFactory;
let FrontendOnlyServiceConnectionProvider = class FrontendOnlyServiceConnectionProvider extends service_connection_provider_1.ServiceConnectionProvider {
    constructor() {
        super(...arguments);
        this.onSocketDidOpen = event_1.Event.None;
        this.onSocketDidClose = event_1.Event.None;
        this.onIncomingMessageActivity = event_1.Event.None;
    }
    createProxy(path, target) {
        this.logger.debug(`[Frontend-Only Fallback] Created proxy connection for ${path}`);
        if (target instanceof proxy_factory_1.RpcProxyFactory) {
            return target.createProxy();
        }
        return new FrontendOnlyRpcProxyFactory(path, target).createProxy();
    }
    listen(path, handler, reconnect) {
        this.logger.debug('[Frontend-Only Fallback] Listen to websocket connection requested');
    }
};
exports.FrontendOnlyServiceConnectionProvider = FrontendOnlyServiceConnectionProvider;
tslib_1.__decorate([
    (0, inversify_1.inject)(logger_1.ILogger),
    (0, inversify_1.named)('core:FrontendOnlyServiceConnectionProvider'),
    tslib_1.__metadata("design:type", Object)
], FrontendOnlyServiceConnectionProvider.prototype, "logger", void 0);
exports.FrontendOnlyServiceConnectionProvider = FrontendOnlyServiceConnectionProvider = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], FrontendOnlyServiceConnectionProvider);
//# sourceMappingURL=frontend-only-service-connection-provider.js.map