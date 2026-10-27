"use strict";
// *****************************************************************************
// Copyright (C) 2025 EclipseSource GmbH and others.
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
exports.AIVariableResourceResolver = exports.NO_CONTEXT_AUTHORITY = exports.AI_VARIABLE_RESOURCE_SCHEME = void 0;
const tslib_1 = require("tslib");
const deepEqual = require("fast-deep-equal");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const stableJsonStringify = require("fast-json-stable-stringify");
const configurable_in_memory_resources_1 = require("./configurable-in-memory-resources");
exports.AI_VARIABLE_RESOURCE_SCHEME = 'ai-variable';
exports.NO_CONTEXT_AUTHORITY = 'context-free';
let AIVariableResourceResolver = class AIVariableResourceResolver {
    constructor() {
        this.cache = new Map();
    }
    init() {
        this.inMemoryResources.onWillDispose(resource => this.cache.delete(resource.uri.toString()));
    }
    getOrCreate(request, context, value) {
        const uri = this.toUri(request, context);
        try {
            const existing = this.inMemoryResources.resolve(uri);
            existing.update({ contents: value });
            return existing;
        }
        catch { /* No-op */ }
        const fresh = this.inMemoryResources.add(uri, { contents: value, readOnly: true, initiallyDirty: false });
        const key = uri.toString();
        this.cache.set(key, [fresh, context]);
        return fresh;
    }
    toUri(request, context) {
        return core_1.URI.fromComponents({
            scheme: exports.AI_VARIABLE_RESOURCE_SCHEME,
            query: stableJsonStringify({ arg: request.arg, name: request.variable.name }),
            path: '/',
            authority: this.toAuthority(context),
            fragment: ''
        });
    }
    toAuthority(context) {
        try {
            if (deepEqual(context, {})) {
                return exports.NO_CONTEXT_AUTHORITY;
            }
            for (const [resource, cachedContext] of this.cache.values()) {
                if (deepEqual(context, cachedContext)) {
                    return resource.uri.authority;
                }
            }
        }
        catch (err) {
            // Mostly that deep equal could overflow the stack, but it should run into === or inequality before that.
            this.logger.warn('Problem evaluating context in AIVariableResourceResolver', err);
        }
        return (0, core_1.generateUuid)();
    }
    fromUri(uri) {
        if (uri.scheme !== exports.AI_VARIABLE_RESOURCE_SCHEME) {
            return undefined;
        }
        try {
            const { name: variableName, arg } = JSON.parse(uri.query);
            return variableName ? {
                variableName,
                arg,
            } : undefined;
        }
        catch {
            return undefined;
        }
    }
};
exports.AIVariableResourceResolver = AIVariableResourceResolver;
tslib_1.__decorate([
    (0, inversify_1.inject)(configurable_in_memory_resources_1.ConfigurableInMemoryResources),
    tslib_1.__metadata("design:type", configurable_in_memory_resources_1.ConfigurableInMemoryResources)
], AIVariableResourceResolver.prototype, "inMemoryResources", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('ai-core:AIVariableResourceResolver'),
    tslib_1.__metadata("design:type", Object)
], AIVariableResourceResolver.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], AIVariableResourceResolver.prototype, "init", null);
exports.AIVariableResourceResolver = AIVariableResourceResolver = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], AIVariableResourceResolver);
//# sourceMappingURL=ai-variable-resource.js.map