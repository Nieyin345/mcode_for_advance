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
const React = require("@theia/core/shared/react");
const event_1 = require("@theia/core/lib/common/event");
const context_key_service_1 = require("@theia/core/lib/browser/context-key-service");
const scm_context_key_service_1 = require("./scm-context-key-service");
const scm_history_graph_widget_1 = require("./scm-history-graph-widget");
disableJSDOM();
class MockContextKeyService extends context_key_service_1.ContextKeyServiceDummyImpl {
    createKey(key, defaultValue) {
        let value = defaultValue;
        return {
            set: (v) => { value = v; },
            reset: () => { value = defaultValue; },
            get: () => value
        };
    }
}
/**
 * Lets React finish the work it scheduled while the DOM is still in place.
 * Disposing a `ReactWidget` unmounts its root, and React flushes the resulting
 * passive effects on a `setImmediate` callback that accesses `window`. Without
 * this, that callback runs after JSDOM has been torn down and fails.
 */
function flushReactWork() {
    return new Promise(resolve => setImmediate(resolve));
}
function createScmContextKeyService() {
    const service = new scm_context_key_service_1.ScmContextKeyService();
    service.contextKeyService = new MockContextKeyService();
    service.init();
    return service;
}
describe('ScmHistoryGraphWidget context keys', () => {
    let restoreJSDOM;
    let widget;
    let scmContextKeys;
    let provider;
    let currentRefInFilter;
    beforeEach(() => {
        restoreJSDOM = (0, jsdom_1.enableJSDOM)();
        scmContextKeys = createScmContextKeyService();
        currentRefInFilter = true;
        widget = new scm_history_graph_widget_1.ScmHistoryGraphWidget();
        const raw = widget;
        raw.scmContextKeys = scmContextKeys;
        Object.defineProperty(raw, 'model', {
            get: () => ({ provider, isCurrentRefInFilter: () => currentRefInFilter })
        });
    });
    afterEach(() => {
        restoreJSDOM();
    });
    function updateContextKeys() {
        widget.updateContextKeys();
    }
    it('should set scmCurrentHistoryItemRefInFilter when the provider has a current ref', () => {
        provider = {
            currentHistoryItemRef: { id: 'refs/heads/main', name: 'main' }
        };
        updateContextKeys();
        (0, chai_1.expect)(scmContextKeys.scmCurrentHistoryItemRefInFilter.get()).to.equal(true);
    });
    it('should clear scmCurrentHistoryItemRefInFilter when the provider has no current ref', () => {
        scmContextKeys.scmCurrentHistoryItemRefInFilter.set(true);
        provider = {};
        updateContextKeys();
        (0, chai_1.expect)(scmContextKeys.scmCurrentHistoryItemRefInFilter.get()).to.equal(false);
    });
    it('should clear scmCurrentHistoryItemRefInFilter when there is no provider', () => {
        scmContextKeys.scmCurrentHistoryItemRefInFilter.set(true);
        provider = undefined;
        updateContextKeys();
        (0, chai_1.expect)(scmContextKeys.scmCurrentHistoryItemRefInFilter.get()).to.equal(false);
    });
    it('should clear scmCurrentHistoryItemRefInFilter when the filter excludes the current ref', () => {
        provider = {
            currentHistoryItemRef: { id: 'refs/heads/main', name: 'main' }
        };
        currentRefInFilter = false;
        updateContextKeys();
        (0, chai_1.expect)(scmContextKeys.scmCurrentHistoryItemRefInFilter.get()).to.equal(false);
    });
    it('should set scmCurrentHistoryItemRefHasRemote when the provider has a remote ref', () => {
        provider = {
            currentHistoryItemRef: { id: 'refs/heads/main', name: 'main' },
            currentHistoryItemRemoteRef: { id: 'refs/remotes/origin/main', name: 'origin/main' }
        };
        updateContextKeys();
        (0, chai_1.expect)(scmContextKeys.scmCurrentHistoryItemRefHasRemote.get()).to.equal(true);
    });
});
describe('ScmHistoryGraphWidget reveal', () => {
    let restoreJSDOM;
    let widget;
    let requestReveal;
    let scrolledTo;
    beforeEach(() => {
        restoreJSDOM = (0, jsdom_1.enableJSDOM)();
        requestReveal = new event_1.Emitter();
        scrolledTo = [];
        widget = new scm_history_graph_widget_1.ScmHistoryGraphWidget();
        const raw = widget;
        raw.scmContextKeys = createScmContextKeyService();
        raw.scmPreferences = { onPreferenceChanged: new event_1.Emitter().event };
        raw.model = {
            provider: undefined,
            entries: [],
            hasMore: false,
            loading: false,
            hasAttemptedLoad: true,
            isCurrentRefInFilter: () => true,
            onDidChange: new event_1.Emitter().event,
            onDidRequestReveal: requestReveal.event
        };
        raw.listRef = { current: { scrollToIndex: (location) => scrolledTo.push(location) } };
        // Rendering is out of scope here and would otherwise run asynchronously,
        // after JSDOM has been torn down again.
        raw.update = () => { };
        widget.init();
    });
    afterEach(async () => {
        widget.dispose();
        await flushReactWork();
        restoreJSDOM();
    });
    function selectedIndex() {
        return widget.selectedIndex;
    }
    it('should scroll to the entry the model asks to reveal', () => {
        requestReveal.fire(4);
        (0, chai_1.expect)(scrolledTo).to.deep.equal([{ index: 4, align: 'center' }]);
    });
    it('should select the entry the model asks to reveal', () => {
        requestReveal.fire(4);
        (0, chai_1.expect)(selectedIndex()).to.equal(4);
    });
    it('should stop revealing once disposed', () => {
        widget.dispose();
        requestReveal.fire(4);
        (0, chai_1.expect)(scrolledTo).to.be.empty;
    });
});
const ROOT_URI = 'file:///repo';
/** Builds the change rows of `commit-1` in the given view mode. */
function renderChanges(widget, viewMode, paths) {
    const raw = widget;
    raw.model = { viewMode };
    raw.scmService = { selectedRepository: { provider: { rootUri: ROOT_URI } } };
    raw.labelProvider = { getIcon: () => 'file-icon' };
    const changes = paths.map(path => ({
        uri: `${ROOT_URI}/${path}`,
        modifiedUri: `${ROOT_URI}/${path}`,
        originalUri: `${ROOT_URI}/${path}`
    }));
    const graphRow = { lane: 0, color: 0, topColor: 0, edges: [], hasContinuation: false, hasTopLine: false };
    const render = widget;
    return render.renderChangesRows('commit-1', 22, graphRow, changes);
}
function allElements(node) {
    const result = [];
    const visit = (candidate) => {
        if (Array.isArray(candidate)) {
            candidate.forEach(visit);
        }
        else if (React.isValidElement(candidate)) {
            result.push(candidate);
            visit(candidate.props.children);
        }
    };
    visit(node);
    return result;
}
function elementsWithClass(node, className) {
    return allElements(node).filter(element => {
        const elementClass = element.props.className;
        return typeof elementClass === 'string' && elementClass.includes(className);
    });
}
/** The rendered name of a row — the `name scm-history-change-name` span it holds. */
function nameOf(row) {
    const name = allElements(row).find(element => element.props.className === 'name scm-history-change-name');
    return String(name?.props?.children ?? '');
}
function folderLabels(rows) {
    return elementsWithClass(rows, 'scm-history-change-folder-row').map(nameOf);
}
function fileNames(rows) {
    return elementsWithClass(rows, 'scm-history-change-row')
        .filter(row => !(row.props.className.includes('scm-history-change-folder-row')))
        .map(nameOf);
}
describe('ScmHistoryGraphWidget change tree folders', () => {
    let restoreJSDOM;
    let widget;
    beforeEach(() => {
        restoreJSDOM = (0, jsdom_1.enableJSDOM)();
        widget = new scm_history_graph_widget_1.ScmHistoryGraphWidget();
        const raw = widget;
        raw.update = () => { };
    });
    afterEach(async () => {
        widget.dispose();
        await flushReactWork();
        restoreJSDOM();
    });
    function internals() {
        return widget;
    }
    it('should show folders expanded by default', () => {
        (0, chai_1.expect)(internals().isFolderCollapsed('commit-1', 'src')).to.be.false;
    });
    it('should collapse a folder on toggle', () => {
        internals().toggleFolder('commit-1', 'src');
        (0, chai_1.expect)(internals().isFolderCollapsed('commit-1', 'src')).to.be.true;
    });
    it('should expand a collapsed folder on toggle', () => {
        internals().toggleFolder('commit-1', 'src');
        internals().toggleFolder('commit-1', 'src');
        (0, chai_1.expect)(internals().isFolderCollapsed('commit-1', 'src')).to.be.false;
    });
    it('should keep folder state separate per history item', () => {
        internals().toggleFolder('commit-1', 'src');
        (0, chai_1.expect)(internals().isFolderCollapsed('commit-2', 'src')).to.be.false;
    });
    it('should render a folder row per folder of the change tree', () => {
        const rows = renderChanges(widget, 'tree', ['src/browser/a.ts', 'src/node/b.ts']);
        (0, chai_1.expect)(folderLabels(rows)).to.deep.equal(['src', 'browser', 'node']);
        (0, chai_1.expect)(fileNames(rows)).to.deep.equal(['a.ts', 'b.ts']);
    });
    it('should render expanded folders with a down twistie', () => {
        const rows = renderChanges(widget, 'tree', ['src/a.ts']);
        (0, chai_1.expect)(elementsWithClass(rows, 'codicon-chevron-down')).to.have.length(1);
    });
    it('should render a flat list of files without folder rows in list mode', () => {
        const rows = renderChanges(widget, 'list', ['src/browser/a.ts', 'src/node/b.ts']);
        (0, chai_1.expect)(folderLabels(rows)).to.be.empty;
        (0, chai_1.expect)(fileNames(rows)).to.deep.equal(['a.ts', 'b.ts']);
    });
    it('should drop the files of a collapsed folder and turn its twistie', () => {
        internals().toggleFolder('commit-1', 'src');
        const rows = renderChanges(widget, 'tree', ['src/browser/a.ts', 'src/node/b.ts']);
        (0, chai_1.expect)(folderLabels(rows)).to.deep.equal(['src']);
        (0, chai_1.expect)(fileNames(rows)).to.be.empty;
        (0, chai_1.expect)(elementsWithClass(rows, 'codicon-chevron-right')).to.have.length(1);
    });
    it('should forget folder state when the history item is collapsed again', () => {
        const raw = widget;
        raw.expandedIds.add('commit-1');
        internals().toggleFolder('commit-1', 'src');
        raw.handleRowClick(0, { item: { id: 'commit-1' } });
        (0, chai_1.expect)(internals().collapsedFolders.has('commit-1')).to.be.false;
    });
});
//# sourceMappingURL=scm-history-graph-widget.spec.js.map