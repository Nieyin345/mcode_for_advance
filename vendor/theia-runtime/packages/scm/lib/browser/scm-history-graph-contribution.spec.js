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
const disableJSDOM = (0, jsdom_1.enableJSDOM)();
const chai_1 = require("chai");
const disposable_1 = require("@theia/core/lib/common/disposable");
const scm_history_graph_contribution_1 = require("./scm-history-graph-contribution");
disableJSDOM();
const ALL_COMMANDS = [
    scm_history_graph_contribution_1.ScmHistoryGraphCommands.REFRESH,
    scm_history_graph_contribution_1.ScmHistoryGraphCommands.PICK_HISTORY_ITEM_REFS,
    scm_history_graph_contribution_1.ScmHistoryGraphCommands.REVEAL_CURRENT_HISTORY_ITEM,
    scm_history_graph_contribution_1.ScmHistoryGraphCommands.SET_LIST_VIEW_MODE,
    scm_history_graph_contribution_1.ScmHistoryGraphCommands.SET_TREE_VIEW_MODE,
];
function createContribution(historyProvider, currentRefInFilter = true) {
    const contribution = new scm_history_graph_contribution_1.ScmHistoryGraphContribution();
    let resolved = false;
    let reveals = 0;
    let viewMode = 'list';
    const internals = contribution;
    internals.scmService = {
        selectedRepository: historyProvider ? { provider: { historyProvider } } : undefined,
    };
    internals.modelProvider = () => {
        resolved = true;
        return {
            historyItemRefFilter: undefined,
            revealCurrentHistoryItem: async () => { reveals++; return undefined; },
            get viewMode() { return viewMode; },
            setViewMode: (mode) => { viewMode = mode; },
        };
    };
    internals.quickInputService = {};
    internals.scmContextKeys = {
        scmCurrentHistoryItemRefInFilter: { get: () => currentRefInFilter },
    };
    const handlers = new Map();
    const registry = {
        registerCommand: (command, handler) => {
            handlers.set(command.id, handler);
            return disposable_1.Disposable.NULL;
        },
    };
    contribution.registerCommands(registry);
    return { handlers, modelResolved: () => resolved, revealCount: () => reveals, viewMode: () => viewMode };
}
describe('ScmHistoryGraphContribution', () => {
    it('does not resolve the graph model for enablement and visibility checks', () => {
        const { handlers, modelResolved } = createContribution({});
        for (const command of ALL_COMMANDS) {
            const handler = handlers.get(command.id);
            (0, chai_1.expect)(handler.isEnabled()).to.be.true;
            (0, chai_1.expect)(handler.isVisible()).to.be.true;
        }
        (0, chai_1.expect)(modelResolved()).to.be.false;
    });
    it('disables the commands when the selected repository has no history provider', () => {
        const { handlers, modelResolved } = createContribution(undefined);
        for (const command of ALL_COMMANDS) {
            const handler = handlers.get(command.id);
            (0, chai_1.expect)(handler.isEnabled()).to.be.false;
            (0, chai_1.expect)(handler.isVisible()).to.be.false;
        }
        (0, chai_1.expect)(modelResolved()).to.be.false;
    });
    it('disables revealing the current history item when the filter excludes the current ref', () => {
        const { handlers } = createContribution({}, false);
        const handler = handlers.get(scm_history_graph_contribution_1.ScmHistoryGraphCommands.REVEAL_CURRENT_HISTORY_ITEM.id);
        (0, chai_1.expect)(handler.isEnabled()).to.be.false;
    });
    it('keeps revealing the current history item visible when the filter excludes the current ref', () => {
        const { handlers } = createContribution({}, false);
        const handler = handlers.get(scm_history_graph_contribution_1.ScmHistoryGraphCommands.REVEAL_CURRENT_HISTORY_ITEM.id);
        (0, chai_1.expect)(handler.isVisible()).to.be.true;
    });
    it('asks the model to reveal the current history item when executed', async () => {
        const { handlers, revealCount } = createContribution({});
        await handlers.get(scm_history_graph_contribution_1.ScmHistoryGraphCommands.REVEAL_CURRENT_HISTORY_ITEM.id).execute();
        (0, chai_1.expect)(revealCount()).to.equal(1);
    });
    it('switches the model to the tree view mode', async () => {
        const { handlers, viewMode } = createContribution({});
        await handlers.get(scm_history_graph_contribution_1.ScmHistoryGraphCommands.SET_TREE_VIEW_MODE.id).execute();
        (0, chai_1.expect)(viewMode()).to.equal('tree');
    });
    it('switches the model back to the list view mode', async () => {
        const { handlers, viewMode } = createContribution({});
        await handlers.get(scm_history_graph_contribution_1.ScmHistoryGraphCommands.SET_TREE_VIEW_MODE.id).execute();
        await handlers.get(scm_history_graph_contribution_1.ScmHistoryGraphCommands.SET_LIST_VIEW_MODE.id).execute();
        (0, chai_1.expect)(viewMode()).to.equal('list');
    });
    it('toggles the view mode command matching the current view mode', async () => {
        const { handlers } = createContribution({});
        const list = handlers.get(scm_history_graph_contribution_1.ScmHistoryGraphCommands.SET_LIST_VIEW_MODE.id);
        const tree = handlers.get(scm_history_graph_contribution_1.ScmHistoryGraphCommands.SET_TREE_VIEW_MODE.id);
        (0, chai_1.expect)(list.isToggled()).to.be.true;
        (0, chai_1.expect)(tree.isToggled()).to.be.false;
        await tree.execute();
        (0, chai_1.expect)(list.isToggled()).to.be.false;
        (0, chai_1.expect)(tree.isToggled()).to.be.true;
    });
});
//# sourceMappingURL=scm-history-graph-contribution.spec.js.map