"use strict";
// *****************************************************************************
// Copyright (C) 2024 EclipseSource GmbH.
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
exports.BackendLanguageModelRegistryImpl = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const common_1 = require("../common");
/**
 * Notifies a client whenever a model is added or removed
 */
let BackendLanguageModelRegistryImpl = class BackendLanguageModelRegistryImpl extends common_1.DefaultLanguageModelRegistryImpl {
    setClient(client) {
        this.client = client;
    }
    addLanguageModels(models) {
        const modelsLength = this.languageModels.length;
        super.addLanguageModels(models);
        // only notify for models which were really added
        for (let i = modelsLength; i < this.languageModels.length; i++) {
            this.client?.languageModelAdded(this.mapToMetaData(this.languageModels[i]));
        }
    }
    removeLanguageModels(ids) {
        super.removeLanguageModels(ids);
        for (const id of ids) {
            this.client?.languageModelRemoved(id);
        }
    }
    async patchLanguageModel(id, patch) {
        await super.patchLanguageModel(id, patch);
        if (this.client) {
            this.client.onLanguageModelUpdated(id);
        }
    }
    mapToMetaData(model) {
        return {
            id: model.id,
            name: model.name,
            status: model.status,
            vendor: model.vendor,
            version: model.version,
            family: model.family,
            maxInputTokens: model.maxInputTokens,
            maxOutputTokens: model.maxOutputTokens,
            released: model.released,
            reasoningSupport: model.reasoningSupport,
            serverTools: model.serverTools,
            serverSideCompactionSupport: model.serverSideCompactionSupport,
        };
    }
};
exports.BackendLanguageModelRegistryImpl = BackendLanguageModelRegistryImpl;
exports.BackendLanguageModelRegistryImpl = BackendLanguageModelRegistryImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], BackendLanguageModelRegistryImpl);
//# sourceMappingURL=backend-language-model-registry.js.map