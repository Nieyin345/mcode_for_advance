"use strict";
// *****************************************************************************
// Copyright (C) 2019 TypeFox and others.
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
exports.ScmContextKeyService = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const context_key_service_1 = require("@theia/core/lib/browser/context-key-service");
let ScmContextKeyService = class ScmContextKeyService {
    get scmProvider() {
        return this._scmProvider;
    }
    get scmProviderContext() {
        return this._scmProviderContext;
    }
    get scmResourceGroup() {
        return this._scmResourceGroup;
    }
    get scmResourceGroupState() {
        return this._scmResourceGroupState;
    }
    get scmProviderCount() {
        return this._scmProviderCount;
    }
    get scmHistoryItemRef() {
        return this._scmHistoryItemRef;
    }
    get scmCurrentHistoryItemRefHasRemote() {
        return this._scmCurrentHistoryItemRefHasRemote;
    }
    get scmCurrentHistoryItemRefHasBase() {
        return this._scmCurrentHistoryItemRefHasBase;
    }
    get scmCurrentHistoryItemRefInFilter() {
        return this._scmCurrentHistoryItemRefInFilter;
    }
    init() {
        this._scmProvider = this.contextKeyService.createKey('scmProvider', undefined);
        this._scmProviderContext = this.contextKeyService.createKey('scmProviderContext', undefined);
        this._scmResourceGroup = this.contextKeyService.createKey('scmResourceGroup', undefined);
        this._scmResourceGroupState = this.contextKeyService.createKey('scmResourceGroupState', undefined);
        this._scmProviderCount = this.contextKeyService.createKey('scm.providerCount', 0);
        this._scmHistoryItemRef = this.contextKeyService.createKey('scmHistoryItemRef', undefined);
        this._scmCurrentHistoryItemRefHasRemote = this.contextKeyService.createKey('scmCurrentHistoryItemRefHasRemote', false);
        this._scmCurrentHistoryItemRefHasBase = this.contextKeyService.createKey('scmCurrentHistoryItemRefHasBase', false);
        this._scmCurrentHistoryItemRefInFilter = this.contextKeyService.createKey('scmCurrentHistoryItemRefInFilter', false);
    }
    match(expression) {
        return !expression || this.contextKeyService.match(expression);
    }
};
exports.ScmContextKeyService = ScmContextKeyService;
tslib_1.__decorate([
    (0, inversify_1.inject)(context_key_service_1.ContextKeyService),
    tslib_1.__metadata("design:type", Object)
], ScmContextKeyService.prototype, "contextKeyService", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], ScmContextKeyService.prototype, "init", null);
exports.ScmContextKeyService = ScmContextKeyService = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], ScmContextKeyService);
//# sourceMappingURL=scm-context-key-service.js.map