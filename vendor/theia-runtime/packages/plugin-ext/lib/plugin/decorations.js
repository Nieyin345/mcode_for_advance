"use strict";
// *****************************************************************************
// Copyright (C) 2019 Red Hat, Inc. and others.
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
exports.DecorationsExtImpl = void 0;
const plugin_api_rpc_1 = require("../common/plugin-api-rpc");
const types_impl_1 = require("./types-impl");
const logger_1 = require("./logger");
class DecorationsExtImpl {
    static { this.handle = 0; }
    static { this.maxEventSize = 250; }
    constructor(rpc) {
        this.rpc = rpc;
        this.proxy = rpc.getProxy(plugin_api_rpc_1.PLUGIN_RPC_CONTEXT.DECORATIONS_MAIN);
        this.logger = new logger_1.PluginLogger(rpc, 'decorations-plugin');
        this.providersMap = new Map();
    }
    registerFileDecorationProvider(provider, pluginInfo) {
        const handle = DecorationsExtImpl.handle++;
        this.providersMap.set(handle, { provider, pluginInfo });
        this.proxy.$registerDecorationProvider(handle);
        const listener = provider.onDidChangeFileDecorations && provider.onDidChangeFileDecorations(e => {
            if (!e) {
                this.proxy.$onDidChange(handle, null);
                return;
            }
            const array = Array.isArray(e) ? e : [e];
            if (array.length <= DecorationsExtImpl.maxEventSize) {
                this.proxy.$onDidChange(handle, array);
                return;
            }
            // too many resources per event: send a flush instead, so that the renderer
            // drops cached data for this provider and re-fetches the decorations it
            // displays on demand. Truncating the event (as upstream VS Code does by
            // picking one resource per folder) loses decorations for the dropped
            // resources, see https://github.com/eclipse-theia/theia/issues/17507
            this.proxy.$onDidChange(handle, null);
        });
        return new types_impl_1.Disposable(() => {
            listener?.dispose();
            this.proxy.$unregisterDecorationProvider(handle);
            this.providersMap.delete(handle);
        });
    }
    async $provideDecorations(handle, requests, token) {
        if (!this.providersMap.has(handle)) {
            // might have been unregistered in the meantime
            return Object.create(null);
        }
        const result = Object.create(null);
        const { provider, pluginInfo } = this.providersMap.get(handle);
        await Promise.all(requests.map(async (request) => {
            try {
                const { uri, id } = request;
                const data = await Promise.resolve(provider.provideFileDecoration(types_impl_1.URI.revive(uri), token));
                if (!data) {
                    return;
                }
                try {
                    types_impl_1.FileDecoration.validate(data);
                    result[id] = [data.propagate, data.tooltip, data.badge, data.color];
                }
                catch (e) {
                    this.logger.warn(`INVALID decoration from extension '${pluginInfo.name}': ${e}`);
                }
            }
            catch (err) {
                this.logger.error(err);
            }
        }));
        return result;
    }
}
exports.DecorationsExtImpl = DecorationsExtImpl;
//# sourceMappingURL=decorations.js.map