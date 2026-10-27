"use strict";
// *****************************************************************************
// Copyright (C) 2023 TypeFox and others.
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
exports.LocalizationExtImpl = void 0;
const tslib_1 = require("tslib");
/* eslint-disable @typescript-eslint/no-explicit-any */
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const localization_1 = require("@theia/core/lib/common/i18n/localization");
const common_1 = require("../common");
const rpc_protocol_1 = require("../common/rpc-protocol");
const types_impl_1 = require("./types-impl");
const logger_1 = require("./logger");
let LocalizationExtImpl = class LocalizationExtImpl {
    constructor() {
        this.isDefaultLanguage = true;
        this.bundleCache = new Map();
    }
    initialize() {
        this._proxy = this.rpc.getProxy(common_1.PLUGIN_RPC_CONTEXT.LOCALIZATION_MAIN);
        this.logger = new logger_1.PluginLogger(this.rpc, 'nls');
    }
    translateMessage(pluginId, details) {
        const { message, args, comment } = details;
        if (this.isDefaultLanguage) {
            return localization_1.Localization.format(message, (args ?? {}));
        }
        let key = message;
        if (comment && comment.length > 0) {
            key += `/${Array.isArray(comment) ? comment.join() : comment}`;
        }
        const str = this.bundleCache.get(pluginId)?.contents[key];
        return localization_1.Localization.format(str ?? message, (args ?? {}));
    }
    getBundle(pluginId) {
        return this.bundleCache.get(pluginId)?.contents;
    }
    getBundleUri(pluginId) {
        const uri = this.bundleCache.get(pluginId)?.uri;
        return uri ? types_impl_1.URI.parse(uri) : undefined;
    }
    async initializeLocalizedMessages(plugin, currentLanguage) {
        this.currentLanguage ??= currentLanguage;
        this.isDefaultLanguage = this.currentLanguage === core_1.nls.defaultLocale;
        if (this.isDefaultLanguage) {
            return;
        }
        if (this.bundleCache.has(plugin.model.id)) {
            return;
        }
        let bundle;
        try {
            bundle = await this._proxy.$fetchBundle(plugin.model.id);
        }
        catch (e) {
            this.logger.error(`Failed to load translations for ${plugin.model.id}: ${e.message}`);
            return;
        }
        this.bundleCache.set(plugin.model.id, bundle);
    }
};
exports.LocalizationExtImpl = LocalizationExtImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(rpc_protocol_1.RPCProtocol),
    tslib_1.__metadata("design:type", Object)
], LocalizationExtImpl.prototype, "rpc", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], LocalizationExtImpl.prototype, "initialize", null);
exports.LocalizationExtImpl = LocalizationExtImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], LocalizationExtImpl);
//# sourceMappingURL=localization-ext.js.map