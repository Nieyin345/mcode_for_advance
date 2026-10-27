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
exports.ResourceContextKey = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("inversify");
const context_key_service_1 = require("./context-key-service");
const language_service_1 = require("./language-service");
let ResourceContextKey = class ResourceContextKey {
    init() {
        this.resource = this.createResourceKey('resource');
        this.resourceSchemeKey = this.createResourceKey('resourceScheme');
        this.resourceFileName = this.createResourceKey('resourceFilename');
        this.resourceExtname = this.createResourceKey('resourceExtname');
        this.resourceLangId = this.createResourceKey('resourceLangId');
        this.resourceDirName = this.createResourceKey('resourceDirName');
        this.resourcePath = this.createResourceKey('resourcePath');
        this.resourceSet = this.createResourceKey('resourceSet', false);
    }
    /**
     * Constrains the key name to the value properties, whose names are the context key identifiers, so that
     * the keys this class creates and the ones it describes a resource with cannot drift apart.
     */
    createResourceKey(name, defaultValue) {
        return this.contextKeyService.createKey(name, defaultValue);
    }
    get() {
        return this.resource.get();
    }
    set(resourceUri) {
        const values = this.toValues(resourceUri);
        this.resource.set(values.resource);
        this.resourceSchemeKey.set(values.resourceScheme);
        this.resourceFileName.set(values.resourceFilename);
        this.resourceExtname.set(values.resourceExtname);
        this.resourceLangId.set(values.resourceLangId);
        this.resourceDirName.set(values.resourceDirName);
        this.resourcePath.set(values.resourcePath);
        this.resourceSet.set(values.resourceSet);
    }
    /**
     * The values describing `resourceUri`, without applying them to the context.
     *
     * @param resourceUri the resource to describe, or `undefined` to obtain the values of an unset resource.
     */
    toValues(resourceUri) {
        return {
            resource: resourceUri?.toString(),
            resourceScheme: resourceUri?.scheme,
            resourceFilename: resourceUri?.path.base,
            resourceExtname: resourceUri?.path.ext,
            resourceLangId: this.getLanguageId(resourceUri),
            resourceDirName: resourceUri?.path.dir.fsPath(),
            resourcePath: resourceUri?.path.fsPath(),
            resourceSet: Boolean(resourceUri)
        };
    }
    getLanguageId(uri) {
        if (uri) {
            for (const language of this.languages.languages) {
                if (language.extensions.has(uri.path.ext)) {
                    return language.id;
                }
            }
        }
        return undefined;
    }
};
exports.ResourceContextKey = ResourceContextKey;
tslib_1.__decorate([
    (0, inversify_1.inject)(language_service_1.LanguageService),
    tslib_1.__metadata("design:type", language_service_1.LanguageService)
], ResourceContextKey.prototype, "languages", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(context_key_service_1.ContextKeyService),
    tslib_1.__metadata("design:type", Object)
], ResourceContextKey.prototype, "contextKeyService", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], ResourceContextKey.prototype, "init", null);
exports.ResourceContextKey = ResourceContextKey = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], ResourceContextKey);
//# sourceMappingURL=resource-context-key.js.map