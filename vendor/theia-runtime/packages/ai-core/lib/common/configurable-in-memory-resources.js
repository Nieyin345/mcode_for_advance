"use strict";
// *****************************************************************************
// Copyright (C) 2025 EclispeSource GmbH and others.
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
exports.ConfigurableMutableReferenceResource = exports.ConfigurableMutableResource = exports.ConfigurableInMemoryResources = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
let ConfigurableInMemoryResources = class ConfigurableInMemoryResources {
    constructor() {
        this.resources = new core_1.SyncReferenceCollection(uri => new ConfigurableMutableResource(new core_1.URI(uri)));
    }
    get onWillDispose() {
        return this.resources.onWillDispose;
    }
    add(uri, options) {
        const resourceUri = uri.toString();
        if (this.resources.has(resourceUri)) {
            throw new Error(`Cannot add already existing in-memory resource '${resourceUri}'`);
        }
        const resource = this.acquire(resourceUri);
        resource.update(options);
        return resource;
    }
    update(uri, options) {
        const resourceUri = uri.toString();
        const resource = this.resources.get(resourceUri);
        if (!resource) {
            throw new Error(`Cannot update non-existent in-memory resource '${resourceUri}'`);
        }
        resource.update(options);
        return resource;
    }
    resolve(uri) {
        const uriString = uri.toString();
        if (!this.resources.has(uriString)) {
            throw new Error(`In memory '${uriString}' resource does not exist.`);
        }
        return this.acquire(uriString);
    }
    acquire(uri) {
        const reference = this.resources.acquire(uri);
        return new ConfigurableMutableReferenceResource(reference);
    }
};
exports.ConfigurableInMemoryResources = ConfigurableInMemoryResources;
exports.ConfigurableInMemoryResources = ConfigurableInMemoryResources = tslib_1.__decorate([
    (0, inversify_1.injectable)()
    /** For creating highly configurable in-memory resources */
], ConfigurableInMemoryResources);
class ConfigurableMutableResource {
    fireDidChangeContents() {
        this.onDidChangeContentsEmitter.fire();
    }
    constructor(uri, options) {
        this.uri = uri;
        this.options = options;
        this.onDidChangeContentsEmitter = new core_1.Emitter();
        this.onDidChangeContents = this.onDidChangeContentsEmitter.event;
        this.onDidChangeReadonlyEmitter = new core_1.Emitter();
        this.onDidChangeReadOnly = this.onDidChangeReadonlyEmitter.event;
    }
    get readOnly() {
        return this.options?.readOnly;
    }
    get autosaveable() {
        return this.options?.autosaveable !== false;
    }
    get initiallyDirty() {
        return !!this.options?.initiallyDirty;
    }
    get contents() {
        return this.options?.contents ?? '';
    }
    readContents() {
        return Promise.resolve(this.options?.contents ?? '');
    }
    async saveContents(contents) {
        await this.options?.onSave?.(contents);
        this.update({ contents });
    }
    update(options) {
        const didContentsChange = 'contents' in options && options.contents !== this.options?.contents;
        const didReadOnlyChange = 'readOnly' in options && options.readOnly !== this.options?.readOnly;
        this.options = { ...this.options, ...options };
        if (didContentsChange) {
            this.onDidChangeContentsEmitter.fire();
        }
        if (didReadOnlyChange) {
            this.onDidChangeReadonlyEmitter.fire(this.readOnly ?? false);
        }
    }
    dispose() {
        this.onDidChangeContentsEmitter.dispose();
    }
}
exports.ConfigurableMutableResource = ConfigurableMutableResource;
class ConfigurableMutableReferenceResource {
    constructor(reference) {
        this.reference = reference;
    }
    get uri() {
        return this.reference.object.uri;
    }
    get onDidChangeContents() {
        return this.reference.object.onDidChangeContents;
    }
    dispose() {
        this.reference.dispose();
    }
    readContents() {
        return this.reference.object.readContents();
    }
    saveContents(contents) {
        return this.reference.object.saveContents(contents);
    }
    update(options) {
        this.reference.object.update(options);
    }
    get readOnly() {
        return this.reference.object.readOnly;
    }
    get initiallyDirty() {
        return this.reference.object.initiallyDirty;
    }
    get autosaveable() {
        return this.reference.object.autosaveable;
    }
    get contents() {
        return this.reference.object.contents;
    }
}
exports.ConfigurableMutableReferenceResource = ConfigurableMutableReferenceResource;
//# sourceMappingURL=configurable-in-memory-resources.js.map