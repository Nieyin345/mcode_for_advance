"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource GmbH and others.
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
const chai_1 = require("chai");
const event_1 = require("@theia/core/lib/common/event");
const scm_history_graph_model_1 = require("./scm-history-graph-model");
class StubHistoryProvider {
    constructor() {
        this.onDidChangeCurrentHistoryItemRefs = new event_1.Emitter().event;
        this.onDidChangeHistoryItemRefsEmitter = new event_1.Emitter();
        this.onDidChangeHistoryItemRefs = this.onDidChangeHistoryItemRefsEmitter.event;
        /** Pages this provider will return on consecutive calls (FIFO). */
        this.pages = [];
        /** Captured options for each call (so tests can assert what was sent). */
        this.receivedOptions = [];
    }
    fireHistoryItemRefsChanged(event) {
        this.onDidChangeHistoryItemRefsEmitter.fire(event);
    }
    async provideHistoryItemRefs() {
        return [];
    }
    async provideHistoryItems(options) {
        this.receivedOptions.push(options);
        return this.pages.shift() ?? [];
    }
    async provideHistoryItemChanges() {
        return [];
    }
    async resolveHistoryItem() {
        return undefined;
    }
    async resolveHistoryItemRefsCommonAncestor() {
        return undefined;
    }
}
function makeItems(start, count) {
    const items = [];
    for (let i = 0; i < count; i++) {
        const id = `c${start + i}`;
        items.push({
            id,
            subject: `commit ${id}`,
            parentIds: [`c${start + i + 1}`],
        });
    }
    return items;
}
/**
 * Instantiates the model with a stub provider, bypassing inversify and the
 * SCM service so tests can drive pagination directly via loadPage().
 * When `wireRepository` is set, the provider is instead wired through a stub
 * selected repository and refresh(), so provider event subscriptions are live.
 */
function createModel(provider, preferences = {}, wireRepository = false) {
    const model = new scm_history_graph_model_1.ScmHistoryGraphModel();
    const internals = model;
    const preferenceEmitter = new event_1.Emitter();
    internals.scmService = {
        onDidChangeSelectedRepository: new event_1.Emitter().event,
        selectedRepository: wireRepository ? { provider: { historyProvider: provider } } : undefined,
    };
    internals.scmPreferences = Object.assign(preferences, { onPreferenceChanged: preferenceEmitter.event });
    internals.init();
    if (!wireRepository) {
        internals._provider = provider;
    }
    return {
        model,
        loadPage: () => internals.loadPage(),
        firePreferenceChanged: preferenceName => preferenceEmitter.fire({ preferenceName }),
    };
}
async function nextTick() {
    return new Promise(resolve => setTimeout(resolve, 0));
}
describe('ScmHistoryGraphModel - pagination', () => {
    it('hasMore is true when a full page returns', async () => {
        const provider = new StubHistoryProvider();
        provider.pages = [makeItems(1, scm_history_graph_model_1.PAGE_SIZE)];
        const { model, loadPage } = createModel(provider);
        await loadPage();
        (0, chai_1.expect)(model.entries).to.have.length(scm_history_graph_model_1.PAGE_SIZE);
        (0, chai_1.expect)(model.hasMore).to.be.true;
    });
    it('hasMore is false when fewer than a full page is returned', async () => {
        const provider = new StubHistoryProvider();
        provider.pages = [makeItems(1, 10)];
        const { model, loadPage } = createModel(provider);
        await loadPage();
        (0, chai_1.expect)(model.entries).to.have.length(10);
        (0, chai_1.expect)(model.hasMore).to.be.false;
    });
    it('paginates using skip = current entry count', async () => {
        const provider = new StubHistoryProvider();
        provider.pages = [
            makeItems(1, scm_history_graph_model_1.PAGE_SIZE),
            makeItems(51, scm_history_graph_model_1.PAGE_SIZE),
            makeItems(101, 10),
        ];
        const { model, loadPage } = createModel(provider);
        await loadPage();
        (0, chai_1.expect)(model.entries).to.have.length(scm_history_graph_model_1.PAGE_SIZE);
        (0, chai_1.expect)(provider.receivedOptions[0].skip).to.equal(0);
        await loadPage();
        (0, chai_1.expect)(model.entries).to.have.length(2 * scm_history_graph_model_1.PAGE_SIZE);
        (0, chai_1.expect)(provider.receivedOptions[1].skip).to.equal(scm_history_graph_model_1.PAGE_SIZE);
        await loadPage();
        (0, chai_1.expect)(model.entries).to.have.length(2 * scm_history_graph_model_1.PAGE_SIZE + 10);
        (0, chai_1.expect)(provider.receivedOptions[2].skip).to.equal(2 * scm_history_graph_model_1.PAGE_SIZE);
    });
    it('passes skip and not cursor (cursor is not part of the VS Code SCM history options API)', async () => {
        const provider = new StubHistoryProvider();
        provider.pages = [makeItems(1, scm_history_graph_model_1.PAGE_SIZE)];
        const { loadPage } = createModel(provider);
        await loadPage();
        (0, chai_1.expect)(provider.receivedOptions[0].cursor).to.be.undefined;
        (0, chai_1.expect)(provider.receivedOptions[0]).to.have.property('skip');
    });
    it('does not grow entries when a provider re-returns duplicates', async () => {
        const provider = new StubHistoryProvider();
        const firstPage = makeItems(1, scm_history_graph_model_1.PAGE_SIZE);
        provider.pages = [firstPage, firstPage.slice()];
        const { model, loadPage } = createModel(provider);
        await loadPage();
        (0, chai_1.expect)(model.entries).to.have.length(scm_history_graph_model_1.PAGE_SIZE);
        await loadPage();
        (0, chai_1.expect)(model.entries).to.have.length(scm_history_graph_model_1.PAGE_SIZE, 'should not grow when all items are duplicates');
    });
});
describe('ScmHistoryGraphModel - page size preference', () => {
    it('requests the configured page size and paginates by it', async () => {
        const provider = new StubHistoryProvider();
        provider.pages = [makeItems(1, 10)];
        const { model, loadPage } = createModel(provider, { 'scm.graph.pageSize': 10 });
        await loadPage();
        (0, chai_1.expect)(provider.receivedOptions[0].limit).to.equal(10);
        (0, chai_1.expect)(model.entries).to.have.length(10);
        (0, chai_1.expect)(model.hasMore).to.be.true;
    });
    it('falls back to the default page size without a preference value', async () => {
        const provider = new StubHistoryProvider();
        provider.pages = [makeItems(1, 10)];
        const { loadPage } = createModel(provider);
        await loadPage();
        (0, chai_1.expect)(provider.receivedOptions[0].limit).to.equal(scm_history_graph_model_1.PAGE_SIZE);
    });
    it('reloads from the start when scm.graph.pageSize changes', async () => {
        const provider = new StubHistoryProvider();
        provider.pages = [makeItems(1, 10), makeItems(1, 5)];
        const preferences = { 'scm.graph.pageSize': 10 };
        const { loadPage, firePreferenceChanged } = createModel(provider, preferences);
        await loadPage();
        (0, chai_1.expect)(provider.receivedOptions[0].limit).to.equal(10);
        preferences['scm.graph.pageSize'] = 5;
        firePreferenceChanged('scm.graph.pageSize');
        await nextTick();
        (0, chai_1.expect)(provider.receivedOptions[1].limit).to.equal(5);
        (0, chai_1.expect)(provider.receivedOptions[1].skip).to.equal(0);
    });
});
describe('ScmHistoryGraphModel - history item ref filter', () => {
    const mainRef = { id: 'refs/heads/main', name: 'main', revision: 'c1' };
    function createFilterProvider() {
        const provider = new StubHistoryProvider();
        provider.currentHistoryItemRef = mainRef;
        provider.pages = [makeItems(1, 3), makeItems(1, 3), makeItems(1, 3)];
        return provider;
    }
    it('is in auto mode by default: current ref revisions are requested and the current ref is in the filter', async () => {
        const provider = createFilterProvider();
        const { model, loadPage } = createModel(provider);
        await loadPage();
        (0, chai_1.expect)(provider.receivedOptions[0].historyItemRefs).to.deep.equal(['c1']);
        (0, chai_1.expect)(model.historyItemRefFilter).to.be.undefined;
        (0, chai_1.expect)(model.isCurrentRefInFilter()).to.be.true;
    });
    it('passes the picked ref ids to the provider and reloads', async () => {
        const provider = createFilterProvider();
        const { model } = createModel(provider);
        model.setHistoryItemRefFilter(['refs/heads/feature']);
        await nextTick();
        (0, chai_1.expect)(provider.receivedOptions[0].historyItemRefs).to.deep.equal(['refs/heads/feature']);
        (0, chai_1.expect)(model.historyItemRefFilter).to.deep.equal(['refs/heads/feature']);
    });
    it('reports whether the current ref is part of the filter', async () => {
        const provider = createFilterProvider();
        const { model } = createModel(provider);
        model.setHistoryItemRefFilter(['refs/heads/feature']);
        await nextTick();
        (0, chai_1.expect)(model.isCurrentRefInFilter()).to.be.false;
        model.setHistoryItemRefFilter(['refs/heads/feature', 'refs/heads/main']);
        await nextTick();
        (0, chai_1.expect)(model.isCurrentRefInFilter()).to.be.true;
    });
    it('returns to auto mode when the filter is cleared', async () => {
        const provider = createFilterProvider();
        const { model } = createModel(provider);
        model.setHistoryItemRefFilter(['refs/heads/feature']);
        await nextTick();
        model.setHistoryItemRefFilter(undefined);
        await nextTick();
        (0, chai_1.expect)(model.historyItemRefFilter).to.be.undefined;
        (0, chai_1.expect)(provider.receivedOptions[1].historyItemRefs).to.deep.equal(['c1']);
    });
    it('does not apply ref role colors to refs excluded by the filter', async () => {
        const provider = createFilterProvider();
        provider.pages = [[
                { id: 'c1', subject: 'head', parentIds: ['c2'], references: [mainRef] },
                { id: 'c2', subject: 'base', parentIds: [] },
            ]];
        const { model } = createModel(provider);
        model.setHistoryItemRefFilter(['refs/heads/feature']);
        await nextTick();
        (0, chai_1.expect)(model.entries[0].graphRow.color).to.not.equal(0);
    });
});
describe('ScmHistoryGraphModel - ref filter pruning', () => {
    const mainRef = { id: 'refs/heads/main', name: 'main', revision: 'c1' };
    const featureRef = { id: 'refs/heads/feature', name: 'feature', revision: 'c5' };
    function createWiredProvider() {
        const provider = new StubHistoryProvider();
        provider.currentHistoryItemRef = mainRef;
        return provider;
    }
    it('drops a removed ref from the filter and keeps the remaining ones', async () => {
        const provider = createWiredProvider();
        const { model } = createModel(provider, {}, true);
        model.setHistoryItemRefFilter([featureRef.id, mainRef.id]);
        await nextTick();
        provider.fireHistoryItemRefsChanged({ added: [], removed: [featureRef], modified: [] });
        await nextTick();
        (0, chai_1.expect)(model.historyItemRefFilter).to.deep.equal([mainRef.id]);
        const last = provider.receivedOptions[provider.receivedOptions.length - 1];
        (0, chai_1.expect)(last.historyItemRefs).to.deep.equal([mainRef.id]);
    });
    it('falls back to auto mode when all filtered refs are removed', async () => {
        const provider = createWiredProvider();
        const { model } = createModel(provider, {}, true);
        model.setHistoryItemRefFilter([featureRef.id]);
        await nextTick();
        provider.fireHistoryItemRefsChanged({ added: [], removed: [featureRef], modified: [] });
        await nextTick();
        (0, chai_1.expect)(model.historyItemRefFilter).to.be.undefined;
        const last = provider.receivedOptions[provider.receivedOptions.length - 1];
        (0, chai_1.expect)(last.historyItemRefs).to.deep.equal(['c1']);
    });
    it('keeps the filter when unrelated refs are removed', async () => {
        const provider = createWiredProvider();
        const { model } = createModel(provider, {}, true);
        model.setHistoryItemRefFilter([mainRef.id]);
        await nextTick();
        provider.fireHistoryItemRefsChanged({ added: [], removed: [featureRef], modified: [] });
        await nextTick();
        (0, chai_1.expect)(model.historyItemRefFilter).to.deep.equal([mainRef.id]);
    });
});
describe('ScmHistoryGraphModel - ref colors and current item', () => {
    const mainRef = { id: 'refs/heads/main', name: 'main', revision: 'c2' };
    const originMainRef = { id: 'refs/remotes/origin/main', name: 'origin/main', revision: 'c1' };
    /** Remote is one commit ahead: c1 (origin/main) → c2 (main = HEAD) → c3. */
    function createBehindProvider() {
        const provider = new StubHistoryProvider();
        provider.currentHistoryItemRef = mainRef;
        provider.currentHistoryItemRemoteRef = originMainRef;
        provider.pages = [[
                { id: 'c1', subject: 'remote only', parentIds: ['c2'], references: [originMainRef] },
                { id: 'c2', subject: 'local head', parentIds: ['c3'], references: [mainRef] },
                { id: 'c3', subject: 'base', parentIds: [] },
            ]];
        return provider;
    }
    it('colors the remote ref tip with the remote ref color', async () => {
        const { model, loadPage } = createModel(createBehindProvider());
        await loadPage();
        (0, chai_1.expect)(model.entries[0].graphRow.color).to.equal(1);
    });
    it('colors the current ref chain with the current ref color', async () => {
        const { model, loadPage } = createModel(createBehindProvider());
        await loadPage();
        (0, chai_1.expect)(model.entries[1].graphRow.color).to.equal(0);
        (0, chai_1.expect)(model.entries[2].graphRow.color).to.equal(0);
    });
    it('prefers the current ref color when a commit carries both local and remote refs', async () => {
        const provider = new StubHistoryProvider();
        const syncedMain = { ...mainRef, revision: 'c1' };
        const syncedRemote = { ...originMainRef, revision: 'c1' };
        provider.currentHistoryItemRef = syncedMain;
        provider.currentHistoryItemRemoteRef = syncedRemote;
        provider.pages = [[
                { id: 'c1', subject: 'in sync', parentIds: [], references: [syncedRemote, syncedMain] },
            ]];
        const { model, loadPage } = createModel(provider);
        await loadPage();
        (0, chai_1.expect)(model.entries[0].graphRow.color).to.equal(0);
    });
    it('marks only the entry at the current ref revision as current', async () => {
        const { model, loadPage } = createModel(createBehindProvider());
        await loadPage();
        (0, chai_1.expect)(model.entries.map(e => e.isCurrent)).to.deep.equal([false, true, false]);
    });
    it('marks no entry as current when the provider has no current ref', async () => {
        const provider = new StubHistoryProvider();
        provider.pages = [makeItems(1, 3)];
        const { model, loadPage } = createModel(provider);
        await loadPage();
        (0, chai_1.expect)(model.entries.every(e => !e.isCurrent)).to.be.true;
    });
});
describe('ScmHistoryGraphModel - view mode', () => {
    it('shows the changes of a history item as a list by default', () => {
        const { model } = createModel(new StubHistoryProvider());
        (0, chai_1.expect)(model.viewMode).to.equal('list');
    });
    it('switches the view mode', () => {
        const { model } = createModel(new StubHistoryProvider());
        model.setViewMode('tree');
        (0, chai_1.expect)(model.viewMode).to.equal('tree');
    });
    it('notifies listeners when the view mode changes', () => {
        const { model } = createModel(new StubHistoryProvider());
        let changes = 0;
        model.onDidChange(() => changes++);
        model.setViewMode('tree');
        (0, chai_1.expect)(changes).to.equal(1);
    });
    it('does not notify listeners when the view mode is unchanged', () => {
        const { model } = createModel(new StubHistoryProvider());
        model.setViewMode('tree');
        let changes = 0;
        model.onDidChange(() => changes++);
        model.setViewMode('tree');
        (0, chai_1.expect)(changes).to.equal(0);
    });
    it('does not reload history when the view mode changes', async () => {
        const provider = new StubHistoryProvider();
        provider.pages = [makeItems(1, 10)];
        const { model, loadPage } = createModel(provider);
        await loadPage();
        const requestsBefore = provider.receivedOptions.length;
        model.setViewMode('tree');
        await nextTick();
        (0, chai_1.expect)(provider.receivedOptions).to.have.length(requestsBefore);
    });
});
describe('ScmHistoryGraphModel - revealing the current history item', () => {
    function createProviderAt(revision) {
        const provider = new StubHistoryProvider();
        provider.currentHistoryItemRef = { id: 'refs/heads/main', name: 'main', revision };
        return provider;
    }
    it('requests a reveal of the index of the current history item', async () => {
        const provider = createProviderAt('c3');
        provider.pages = [makeItems(1, 10)];
        const { model, loadPage } = createModel(provider);
        await loadPage();
        const revealed = [];
        model.onDidRequestReveal(revealedIndex => revealed.push(revealedIndex));
        const index = await model.revealCurrentHistoryItem();
        (0, chai_1.expect)(index).to.equal(2);
        (0, chai_1.expect)(revealed).to.deep.equal([2]);
    });
    it('loads further pages until the current history item is found', async () => {
        const provider = createProviderAt('c55');
        provider.pages = [makeItems(1, scm_history_graph_model_1.PAGE_SIZE), makeItems(scm_history_graph_model_1.PAGE_SIZE + 1, scm_history_graph_model_1.PAGE_SIZE)];
        const { model, loadPage } = createModel(provider);
        await loadPage();
        (0, chai_1.expect)(model.entries).to.have.length(scm_history_graph_model_1.PAGE_SIZE);
        const index = await model.revealCurrentHistoryItem();
        (0, chai_1.expect)(index).to.equal(54);
        (0, chai_1.expect)(model.entries).to.have.length(2 * scm_history_graph_model_1.PAGE_SIZE);
    });
    it('does not request a reveal when the current history item is not in the history', async () => {
        const provider = createProviderAt('not-loaded');
        provider.pages = [makeItems(1, 10)];
        const { model, loadPage } = createModel(provider);
        await loadPage();
        const revealed = [];
        model.onDidRequestReveal(revealedIndex => revealed.push(revealedIndex));
        const index = await model.revealCurrentHistoryItem();
        (0, chai_1.expect)(index).to.be.undefined;
        (0, chai_1.expect)(revealed).to.be.empty;
    });
    it('does not request a reveal when the provider has no current history item ref', async () => {
        const provider = new StubHistoryProvider();
        provider.pages = [makeItems(1, 10)];
        const { model, loadPage } = createModel(provider);
        await loadPage();
        const revealed = [];
        model.onDidRequestReveal(revealedIndex => revealed.push(revealedIndex));
        const index = await model.revealCurrentHistoryItem();
        (0, chai_1.expect)(index).to.be.undefined;
        (0, chai_1.expect)(revealed).to.be.empty;
    });
    it('stops paging when further pages add no new items', async () => {
        const provider = createProviderAt('never-returned');
        const page = makeItems(1, scm_history_graph_model_1.PAGE_SIZE);
        // A provider that keeps returning the same full page: `hasMore` stays true
        // forever, so only a no-progress guard can end the search.
        provider.provideHistoryItems = async (options) => {
            provider.receivedOptions.push(options);
            return page;
        };
        const { model, loadPage } = createModel(provider);
        await loadPage();
        (0, chai_1.expect)(model.hasMore).to.be.true;
        const index = await model.revealCurrentHistoryItem();
        (0, chai_1.expect)(index).to.be.undefined;
        (0, chai_1.expect)(model.entries).to.have.length(scm_history_graph_model_1.PAGE_SIZE);
    });
});
//# sourceMappingURL=scm-history-graph-model.spec.js.map