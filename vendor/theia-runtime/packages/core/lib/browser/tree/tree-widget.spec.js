"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const jsx_runtime_1 = require("react/jsx-runtime");
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
const jsdom_1 = require("../test/jsdom");
// The widget module transitively imports `@lumino/widgets`, which touches `document` at load time.
let disableJSDOM = (0, jsdom_1.enableJSDOM)();
const chai_1 = require("chai");
const react_dom_1 = require("react-dom");
const client_1 = require("react-dom/client");
const tree_1 = require("./tree");
const tree_widget_1 = require("./tree-widget");
disableJSDOM();
class CountingView extends tree_widget_1.TreeWidget.View {
    constructor() {
        super(...arguments);
        this.scrollCount = 0;
        this.scrollIntoViewIfNeeded = () => {
            if (this.list && this.props.scrollToRow !== undefined) {
                this.scrollCount++;
            }
        };
    }
}
class TestTreeWidget extends tree_widget_1.TreeWidget {
    constructor() {
        super(...arguments);
        this.scrollToSelectedCount = 0;
    }
    update() { }
    scrollToSelected() {
        this.scrollToSelectedCount++;
    }
    get RowRenderer() {
        return this.ScrollingRowRenderer;
    }
    get currentScrollToRow() {
        return this.scrollToRow;
    }
    get currentScrollToRowRequestId() {
        return this.scrollToRowRequestId;
    }
    requestScrollToFocus() {
        this.updateScrollToRow();
    }
    doUpdateRowsNow() {
        this.doUpdateRows();
    }
}
function createTreeRoot(...children) {
    const root = { id: 'root', name: 'root', parent: undefined, visible: false, children: [] };
    return tree_1.CompositeTreeNode.addChildren(root, children);
}
function leaf(id) {
    return { id, name: id, parent: undefined, visible: true };
}
describe('TreeWidget', () => {
    before(() => disableJSDOM = (0, jsdom_1.enableJSDOM)());
    after(() => disableJSDOM());
    describe('scroll requests', () => {
        let widget;
        let model;
        beforeEach(() => {
            model = { root: undefined };
            widget = new TestTreeWidget(tree_widget_1.defaultTreeProps, model, {});
            Object.assign(widget, {
                focusService: { get focusedNode() { return widget.focusedNode; } },
                scheduleUpdateScrollToRow: () => widget.requestScrollToFocus()
            });
        });
        afterEach(() => widget.dispose());
        it('scrolls to the focused row when a scroll is requested', () => {
            const target = leaf('target');
            model.root = createTreeRoot(leaf('a'), leaf('b'), target);
            widget.doUpdateRowsNow();
            widget.focusedNode = target;
            const requestId = widget.currentScrollToRowRequestId;
            widget.requestScrollToFocus();
            (0, chai_1.expect)(widget.currentScrollToRow).to.equal(2);
            (0, chai_1.expect)(widget.currentScrollToRowRequestId).to.not.equal(requestId);
        });
        it('does not scroll again when the rows update after the request was served', () => {
            const target = leaf('target');
            model.root = createTreeRoot(leaf('a'), target);
            widget.doUpdateRowsNow();
            widget.focusedNode = target;
            widget.requestScrollToFocus();
            const requestId = widget.currentScrollToRowRequestId;
            // A file created above the focused node shifts its row.
            model.root = createTreeRoot(leaf('a'), leaf('new'), target);
            widget.doUpdateRowsNow();
            (0, chai_1.expect)(widget.currentScrollToRow).to.equal(1);
            (0, chai_1.expect)(widget.currentScrollToRowRequestId).to.equal(requestId);
        });
        it('keeps a request pending until the rows contain the focused node', () => {
            const target = leaf('target');
            const folder = { id: 'folder', name: 'folder', parent: undefined, visible: true, expanded: false, children: [] };
            tree_1.CompositeTreeNode.addChild(folder, target);
            model.root = createTreeRoot(leaf('a'), folder);
            widget.doUpdateRowsNow();
            widget.focusedNode = target;
            widget.requestScrollToFocus();
            (0, chai_1.expect)(widget.currentScrollToRow).to.be.undefined;
            const requestId = widget.currentScrollToRowRequestId;
            // The reveal expands the collapsed parent.
            folder.expanded = true;
            widget.doUpdateRowsNow();
            (0, chai_1.expect)(widget.currentScrollToRow).to.equal(2);
            (0, chai_1.expect)(widget.currentScrollToRowRequestId).to.not.equal(requestId);
            // Once served, a later rows update does not scroll again.
            const servedRequestId = widget.currentScrollToRowRequestId;
            widget.doUpdateRowsNow();
            (0, chai_1.expect)(widget.currentScrollToRowRequestId).to.equal(servedRequestId);
        });
    });
    describe('non-virtualized rows', () => {
        let container;
        let root;
        let widget;
        const render = (scrollToRowRequestId) => (0, react_dom_1.flushSync)(() => root.render((0, jsx_runtime_1.jsx)(widget.RowRenderer, { rows: [], scrollToRowRequestId: scrollToRowRequestId })));
        beforeEach(() => {
            widget = new TestTreeWidget({ ...tree_widget_1.defaultTreeProps, virtualized: false }, { root: undefined }, {});
            container = document.createElement('div');
            document.body.appendChild(container);
            root = (0, client_1.createRoot)(container);
        });
        afterEach(() => {
            (0, react_dom_1.flushSync)(() => root.unmount());
            document.body.removeChild(container);
            widget.dispose();
        });
        it('scrolls to the selection once per scroll request, not on every render', () => {
            render(1);
            const scrollsAfterMount = widget.scrollToSelectedCount;
            render(1);
            render(1);
            (0, chai_1.expect)(widget.scrollToSelectedCount).to.equal(scrollsAfterMount);
            render(2);
            (0, chai_1.expect)(widget.scrollToSelectedCount).to.equal(scrollsAfterMount + 1);
        });
    });
    describe('View', () => {
        let container;
        let root;
        let view;
        const rows = [0, 1, 2].map(index => ({ index, depth: 0, node: leaf(`node-${index}`) }));
        const render = (props) => (0, react_dom_1.flushSync)(() => root.render((0, jsx_runtime_1.jsx)(CountingView, { ref: instance => { view = instance ?? undefined; }, width: 100, height: 100, rows: rows, renderNodeRow: row => (0, jsx_runtime_1.jsx)("div", { children: row.node.id }), ...props })));
        beforeEach(() => {
            container = document.createElement('div');
            document.body.appendChild(container);
            root = (0, client_1.createRoot)(container);
        });
        afterEach(() => {
            (0, react_dom_1.flushSync)(() => root.unmount());
            document.body.removeChild(container);
        });
        it('does not scroll again when re-rendered without a new scroll request', () => {
            render({ scrollToRow: 2, scrollToRowRequestId: 1 });
            const scrollsAfterMount = view.scrollCount;
            render({ scrollToRow: 2, scrollToRowRequestId: 1 });
            render({ scrollToRow: 2, scrollToRowRequestId: 1 });
            (0, chai_1.expect)(view.scrollCount).to.equal(scrollsAfterMount);
        });
        it('scrolls again when a new scroll request arrives for the same row', () => {
            render({ scrollToRow: 2, scrollToRowRequestId: 1 });
            const scrollsAfterMount = view.scrollCount;
            render({ scrollToRow: 2, scrollToRowRequestId: 2 });
            (0, chai_1.expect)(view.scrollCount).to.equal(scrollsAfterMount + 1);
        });
        it('scrolls when the row to scroll to changes', () => {
            render({ scrollToRow: 1 });
            const scrollsAfterMount = view.scrollCount;
            render({ scrollToRow: 2 });
            (0, chai_1.expect)(view.scrollCount).to.equal(scrollsAfterMount + 1);
        });
    });
});
//# sourceMappingURL=tree-widget.spec.js.map