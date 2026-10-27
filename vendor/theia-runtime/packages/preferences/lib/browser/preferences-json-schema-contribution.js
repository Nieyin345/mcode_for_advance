"use strict";
// *****************************************************************************
// Copyright (C) 2018 TypeFox and others.
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
exports.PreferencesJsonSchemaContribution = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const uri_1 = require("@theia/core/lib/common/uri");
const json_schema_store_1 = require("@theia/core/lib/browser/json-schema-store");
const browser_1 = require("@theia/workspace/lib/browser");
const core_1 = require("@theia/core");
const browser_2 = require("@theia/userstorage/lib/browser");
const debounce = require("@theia/core/shared/lodash.debounce");
const PREFERENCE_URI_PREFIX = 'vscode://schemas/settings/';
const DEBOUNCED_UPDATE_DELAY = 200;
let PreferencesJsonSchemaContribution = class PreferencesJsonSchemaContribution {
    constructor() {
        this.debouncedUpdateInMemoryResources = debounce(() => this.updateInMemoryResources(), DEBOUNCED_UPDATE_DELAY);
    }
    registerSchemas(context) {
        this.registerSchema(core_1.PreferenceScope.Default, context);
        this.registerSchema(core_1.PreferenceScope.User, context);
        this.registerSchema(core_1.PreferenceScope.Workspace, context);
        this.registerSchema(core_1.PreferenceScope.Folder, context);
        context.registerSchema({
            fileMatch: `file://**/${this.preferenceConfigurations.getConfigName()}.json`,
            url: this.getSchemaURIForScope(core_1.PreferenceScope.Folder).toString()
        });
        context.registerSchema({
            fileMatch: browser_2.UserStorageUri.resolve(this.preferenceConfigurations.getConfigName() + '.json').toString(),
            url: this.getSchemaURIForScope(core_1.PreferenceScope.User).toString()
        });
        this.workspaceService.updateSchema('settings', { $ref: this.getSchemaURIForScope(core_1.PreferenceScope.Workspace).toString() });
        this.schemaProvider.onDidChangeSchema(() => this.debouncedUpdateInMemoryResources());
    }
    registerSchema(scope, context) {
        const scopeStr = core_1.PreferenceScope[scope].toLowerCase();
        const uri = new uri_1.default(PREFERENCE_URI_PREFIX + scopeStr);
        this.jsonSchemaData.setSchema(uri, (this.schemaProvider.getJSONSchema(scope)));
    }
    updateInMemoryResources() {
        this.jsonSchemaData.setSchema(this.getSchemaURIForScope(core_1.PreferenceScope.Default), (this.schemaProvider.getJSONSchema(core_1.PreferenceScope.Default)));
        this.jsonSchemaData.setSchema(this.getSchemaURIForScope(core_1.PreferenceScope.User), this.schemaProvider.getJSONSchema(core_1.PreferenceScope.User));
        this.jsonSchemaData.setSchema(this.getSchemaURIForScope(core_1.PreferenceScope.Workspace), this.schemaProvider.getJSONSchema(core_1.PreferenceScope.Workspace));
        this.jsonSchemaData.setSchema(this.getSchemaURIForScope(core_1.PreferenceScope.Folder), this.schemaProvider.getJSONSchema(core_1.PreferenceScope.Folder));
    }
    getSchemaURIForScope(scope) {
        return new uri_1.default(PREFERENCE_URI_PREFIX + core_1.PreferenceScope[scope].toLowerCase());
    }
};
exports.PreferencesJsonSchemaContribution = PreferencesJsonSchemaContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.PreferenceSchemaService),
    tslib_1.__metadata("design:type", Object)
], PreferencesJsonSchemaContribution.prototype, "schemaProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.PreferenceConfigurations),
    tslib_1.__metadata("design:type", core_1.PreferenceConfigurations)
], PreferencesJsonSchemaContribution.prototype, "preferenceConfigurations", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(json_schema_store_1.JsonSchemaDataStore),
    tslib_1.__metadata("design:type", json_schema_store_1.JsonSchemaDataStore)
], PreferencesJsonSchemaContribution.prototype, "jsonSchemaData", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.WorkspaceService),
    tslib_1.__metadata("design:type", browser_1.WorkspaceService)
], PreferencesJsonSchemaContribution.prototype, "workspaceService", void 0);
exports.PreferencesJsonSchemaContribution = PreferencesJsonSchemaContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], PreferencesJsonSchemaContribution);
//# sourceMappingURL=preferences-json-schema-contribution.js.map