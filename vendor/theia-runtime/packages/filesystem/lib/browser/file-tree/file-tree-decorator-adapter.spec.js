"use strict";
// *****************************************************************************
// Copyright (C) 2026 Safi Seid-Ahmad, K2view and others.
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
const jsdom_1 = require("@theia/core/lib/browser/test/jsdom");
let disableJSDOM = (0, jsdom_1.enableJSDOM)();
const color_registry_1 = require("@theia/core/lib/browser/color-registry");
const decorations_service_1 = require("@theia/core/lib/browser/decorations-service");
const common_1 = require("@theia/core/lib/common");
const uri_1 = require("@theia/core/lib/common/uri");
const inversify_1 = require("@theia/core/shared/inversify");
const chai_1 = require("chai");
const file_tree_decorator_adapter_1 = require("./file-tree-decorator-adapter");
disableJSDOM();
class TestDecorationsProvider {
    constructor() {
        this.onDidChangeEmitter = new common_1.Emitter();
        this.decorations = new Map();
        this.queried = [];
    }
    get onDidChange() {
        return this.onDidChangeEmitter.event;
    }
    fireDidChange(uris) {
        this.onDidChangeEmitter.fire(uris);
    }
    provideDecorations(uri, token) {
        this.queried.push(uri.toString());
        return Promise.resolve(this.decorations.get(uri.toString()));
    }
}
function createTree(uris) {
    const root = {
        id: 'root',
        name: 'root',
        parent: undefined,
        children: []
    };
    const children = uris.map(uri => ({
        id: uri,
        name: new uri_1.default(uri).path.base,
        parent: root,
        fileStat: { resource: new uri_1.default(uri) }
    }));
    children.forEach((child, index) => Object.assign(child, { nextSibling: children[index + 1] }));
    Object.assign(root, { children });
    return { root };
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
describe('FileTreeDecoratorAdapter', () => {
    before(() => {
        disableJSDOM = (0, jsdom_1.enableJSDOM)();
    });
    after(() => {
        disableJSDOM();
    });
    const fileUris = ['file:///project/f1.ts', 'file:///project/f2.ts', 'file:///project/f3.ts'];
    let service;
    let provider;
    let adapter;
    let tree;
    beforeEach(() => {
        service = new decorations_service_1.DecorationsServiceImpl();
        provider = new TestDecorationsProvider();
        service.registerDecorationsProvider(provider);
        const container = new inversify_1.Container();
        container.bind(decorations_service_1.DecorationsService).toConstantValue(service);
        container.bind(color_registry_1.ColorRegistry).toSelf().inSingletonScope();
        container.bind(file_tree_decorator_adapter_1.FileTreeDecoratorAdapter).toSelf().inSingletonScope();
        adapter = container.get(file_tree_decorator_adapter_1.FileTreeDecoratorAdapter);
        tree = createTree(fileUris);
    });
    afterEach(() => {
        service.dispose();
    });
    it('fetches decorations on demand for resources never mentioned in a change event', async () => {
        for (const uri of fileUris) {
            provider.decorations.set(uri, { letter: 'U', bubble: true });
        }
        // simulates a render: nothing decorated yet, but fetches are triggered
        (0, chai_1.expect)(await adapter.decorations(tree)).to.have.lengthOf(0);
        await sleep(20);
        const decorations = await adapter.decorations(tree);
        for (const uri of fileUris) {
            (0, chai_1.expect)(decorations.has(uri), uri).to.equal(true);
        }
    });
    it('does not re-query the provider for undecorated resources on repeated renders', async () => {
        await adapter.decorations(tree);
        await sleep(20);
        const queriesAfterFirstRender = provider.queried.length;
        await adapter.decorations(tree);
        await adapter.decorations(tree);
        await sleep(20);
        (0, chai_1.expect)(provider.queried.length).to.equal(queriesAfterFirstRender);
    });
    it('does not query the decorations service for undecorated resources on repeated renders', async () => {
        const originalGetDecoration = service.getDecoration.bind(service);
        let queries = 0;
        service.getDecoration = (uri, includeChildren) => {
            queries++;
            return originalGetDecoration(uri, includeChildren);
        };
        await adapter.decorations(tree);
        await sleep(20);
        const queriesAfterFirstRender = queries;
        await adapter.decorations(tree);
        await adapter.decorations(tree);
        (0, chai_1.expect)(queries).to.equal(queriesAfterFirstRender);
    });
    it('recovers decorations of resources cached as undecorated after a flush event', async () => {
        // resources are queried before the provider has any data, e.g. before
        // the initial git status is computed
        await adapter.decorations(tree);
        await sleep(20);
        (0, chai_1.expect)(await adapter.decorations(tree)).to.have.lengthOf(0);
        // data becomes available, but the change event exceeds the plugin-ext
        // event cap and arrives as a flush (see #17507)
        for (const uri of fileUris) {
            provider.decorations.set(uri, { letter: 'M' });
        }
        let treeInvalidated = false;
        adapter.onDidChangeDecorations(() => {
            treeInvalidated = true;
        });
        provider.fireDidChange(undefined);
        await sleep(20);
        (0, chai_1.expect)(treeInvalidated, 'flush must invalidate the tree decorations').to.equal(true);
        // the invalidation makes the tree render, which re-fetches on demand ...
        await adapter.decorations(tree);
        await sleep(20);
        // ... and the next render shows every decoration
        const decorations = await adapter.decorations(tree);
        for (const uri of fileUris) {
            (0, chai_1.expect)(decorations.get(uri)?.tailDecorations?.some(tail => 'data' in tail && tail.data === 'M'), uri).to.equal(true);
        }
    });
});
//# sourceMappingURL=file-tree-decorator-adapter.spec.js.map