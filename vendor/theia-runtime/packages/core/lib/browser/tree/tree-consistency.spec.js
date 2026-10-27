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
const tslib_1 = require("tslib");
const assert = require("assert");
const inversify_1 = require("inversify");
const tree_test_container_1 = require("./test/tree-test-container");
const tree_1 = require("./tree");
const tree_model_1 = require("./tree-model");
const tree_label_provider_1 = require("./tree-label-provider");
const mock_tree_model_1 = require("./test/mock-tree-model");
const common_1 = require("../../common");
const promise_util_1 = require("../../common/promise-util");
let ConsistencyTestTree = class ConsistencyTestTree extends tree_1.TreeImpl {
    constructor() {
        super(...arguments);
        this.resolveCounter = 0;
    }
    async resolveChildren(parent) {
        if (parent.id === 'expandable') {
            const step = async () => {
                // a predicate to emulate bad timing, i.e.
                // children of a node gets resolved when a root is changed
                if (this.root && this.root !== parent.parent) {
                    this.resolveCounter++;
                    return [];
                }
                else {
                    await new Promise(resolve => setTimeout(resolve, 10));
                    return step();
                }
            };
            return step();
        }
        return super.resolveChildren(parent);
    }
};
ConsistencyTestTree = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], ConsistencyTestTree);
/**
 * Return roots having the same id, but not object identity.
 */
function createConsistencyTestRoot(rootName) {
    const children = [];
    const root = {
        id: 'root',
        name: rootName,
        parent: undefined,
        children
    };
    const parent = {
        id: 'expandable',
        name: 'expandable',
        parent: root,
        expanded: true,
        children: []
    };
    children.push(parent);
    return root;
}
/**
 * A `TreeImpl` whose `resolveChildren` can be stalled or overridden per node id, to
 * simulate slow child resolution (e.g. a file system request) in tests.
 */
let StallingTestTree = class StallingTestTree extends tree_1.TreeImpl {
    constructor() {
        super(...arguments);
        this.stalled = new Map();
        this.overrides = new Map();
    }
    /**
     * Stall the *next* `resolveChildren` for `id` on the returned deferred. Later
     * resolutions for the same id proceed normally, so the stall cannot leak into
     * unrelated refreshes (e.g. the cascade of a newly set root).
     */
    stallNextResolve(id) {
        const gate = new promise_util_1.Deferred();
        this.stalled.set(id, gate);
        return gate;
    }
    /** Make the *next* `resolveChildren` for `id` return `children()` instead of the current child nodes. */
    overrideNextResolve(id, children) {
        this.overrides.set(id, children);
    }
    resolveChildren(parent) {
        const gate = this.stalled.get(parent.id);
        if (gate) {
            this.stalled.delete(parent.id);
            return gate.promise;
        }
        const override = this.overrides.get(parent.id);
        if (override) {
            this.overrides.delete(parent.id);
            return Promise.resolve(override());
        }
        return super.resolveChildren(parent);
    }
};
StallingTestTree = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], StallingTestTree);
describe('Tree Consistency', () => {
    it('setting different tree roots should finish', async () => {
        const container = (0, tree_test_container_1.createTreeTestContainer)();
        container.bind(tree_label_provider_1.TreeLabelProvider).toSelf().inSingletonScope();
        const labelProvider = container.get(tree_label_provider_1.TreeLabelProvider);
        container.bind(ConsistencyTestTree).toSelf();
        container.rebind(tree_1.TreeImpl).toService(ConsistencyTestTree);
        const tree = container.get(ConsistencyTestTree);
        const model = container.get(tree_model_1.TreeModel);
        model.root = createConsistencyTestRoot('Foo');
        await new Promise(resolve => setTimeout(resolve, 50));
        model.root = createConsistencyTestRoot('Bar');
        await new Promise(resolve => setTimeout(resolve, 50));
        let resolveCounter = tree.resolveCounter;
        assert.deepStrictEqual(tree.resolveCounter, 1);
        for (let i = 0; i < 10; i++) {
            await new Promise(resolve => setTimeout(resolve, 50));
            if (resolveCounter === tree.resolveCounter) {
                assert.deepStrictEqual(tree.resolveCounter, 1);
                assert.deepStrictEqual(labelProvider.getName(model.root), 'Bar');
                return;
            }
            resolveCounter = tree.resolveCounter;
        }
        assert.ok(false, 'Resolving does not stop, attempts: ' + tree.resolveCounter);
    });
    describe('stale refreshes', () => {
        let tree;
        let model;
        let loggedErrors;
        beforeEach(async () => {
            const container = (0, tree_test_container_1.createTreeTestContainer)();
            container.bind(StallingTestTree).toSelf();
            container.rebind(tree_1.TreeImpl).toService(StallingTestTree);
            tree = container.get(StallingTestTree);
            model = container.get(tree_model_1.TreeModel);
            loggedErrors = [];
            const logger = container.get(common_1.ILogger);
            logger.error = async (...args) => { loggedErrors.push(args); };
            model.root = mock_tree_model_1.MockTreeModel.HIERARCHICAL_MOCK_ROOT();
            // let the refresh cascade triggered by setting the root settle
            await (0, promise_util_1.timeout)(0);
        });
        it('drops an in-flight refresh when the root is replaced meanwhile', async () => {
            const stale = model.getNode('1.2');
            const gate = tree.stallNextResolve('1.2');
            const pendingRefresh = tree.refresh(stale);
            model.root = mock_tree_model_1.MockTreeModel.HIERARCHICAL_MOCK_ROOT();
            gate.resolve(Array.from(stale.children));
            assert.strictEqual(await pendingRefresh, undefined);
            assert.deepStrictEqual(loggedErrors, []);
            const fresh = model.getNode('1.2');
            assert.ok(fresh);
            assert.notStrictEqual(fresh, stale);
        });
        it('does not resurrect a removed subtree when a stale refresh completes', async () => {
            const target = model.getNode('1.2');
            const gate = tree.stallNextResolve('1.2');
            const pendingRefresh = tree.refresh(target);
            tree_1.CompositeTreeNode.removeChild(target.parent, target, tree);
            assert.strictEqual(model.getNode('1.2'), undefined);
            gate.resolve(Array.from(target.children));
            assert.strictEqual(await pendingRefresh, undefined);
            assert.strictEqual(model.getNode('1.2'), undefined);
            assert.strictEqual(model.getNode('1.2.1'), undefined);
        });
        it('does not re-index a node object that a concurrent ancestor refresh replaced', async () => {
            const stale = model.getNode('1.2');
            const gate = tree.stallNextResolve('1.2');
            const pendingRefresh = tree.refresh(stale);
            // an ancestor refresh yields a *fresh* object for the same id, as trees whose
            // `resolveChildren` builds new nodes do
            const parent = model.getNode('1');
            const replacement = { id: '1.2', name: '1.2', parent, children: [] };
            tree.overrideNextResolve('1', () => parent.children.map(child => child.id === '1.2' ? replacement : child));
            await tree.refresh(parent);
            assert.strictEqual(model.getNode('1.2'), replacement);
            gate.resolve(Array.from(stale.children));
            assert.strictEqual(await pendingRefresh, undefined);
            assert.deepStrictEqual(loggedErrors, []);
            // the stale object must not take the replacement's place in the index, nor bring its children back
            assert.strictEqual(model.getNode('1.2'), replacement);
            assert.strictEqual(model.getNode('1.2.1'), undefined);
        });
    });
});
//# sourceMappingURL=tree-consistency.spec.js.map