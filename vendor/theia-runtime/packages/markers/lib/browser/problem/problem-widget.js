"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProblemMarkerRemoveButton = exports.ProblemWidget = exports.PROBLEMS_WIDGET_ID = void 0;
const tslib_1 = require("tslib");
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
// *****************************************************************************
// Copyright (C) 2017 TypeFox and others.
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
const inversify_1 = require("@theia/core/shared/inversify");
const problem_manager_1 = require("./problem-manager");
const problem_marker_1 = require("../../common/problem-marker");
const problem_tree_model_1 = require("./problem-tree-model");
const marker_tree_1 = require("../marker-tree");
const browser_1 = require("@theia/core/lib/browser");
const vscode_languageserver_protocol_1 = require("@theia/core/shared/vscode-languageserver-protocol");
const React = require("@theia/core/shared/react");
const problem_preferences_1 = require("../../common/problem-preferences");
const disposable_1 = require("@theia/core/lib/common/disposable");
const nls_1 = require("@theia/core/lib/common/nls");
exports.PROBLEMS_WIDGET_ID = 'problems';
let ProblemWidget = class ProblemWidget extends browser_1.TreeWidget {
    constructor(treeProps, model, contextMenuRenderer) {
        super(treeProps, model, contextMenuRenderer);
        this.model = model;
        this.toDisposeOnCurrentWidgetChanged = new disposable_1.DisposableCollection();
        this.id = exports.PROBLEMS_WIDGET_ID;
        this.title.label = nls_1.nls.localizeByDefault('Problems');
        this.title.caption = this.title.label;
        this.title.iconClass = (0, browser_1.codicon)('warning');
        this.title.closable = true;
        this.addClass('theia-marker-container');
    }
    init() {
        super.init();
        this.updateFollowActiveEditor();
        this.toDispose.push(this.preferences.onPreferenceChanged(e => {
            if (e.preferenceName === 'problems.autoReveal') {
                this.updateFollowActiveEditor();
            }
        }));
    }
    onActivateRequest(msg) {
        super.onActivateRequest(msg);
        this.update();
    }
    updateFollowActiveEditor() {
        this.toDisposeOnCurrentWidgetChanged.dispose();
        this.toDispose.push(this.toDisposeOnCurrentWidgetChanged);
        if (this.preferences.get('problems.autoReveal')) {
            this.followActiveEditor();
        }
    }
    followActiveEditor() {
        this.autoRevealFromActiveEditor();
        this.toDisposeOnCurrentWidgetChanged.push(this.shell.onDidChangeCurrentWidget(() => this.autoRevealFromActiveEditor()));
    }
    autoRevealFromActiveEditor() {
        const widget = this.shell.currentWidget;
        if (widget && browser_1.Navigatable.is(widget)) {
            const uri = widget.getResourceUri();
            const node = uri && this.model.getNode(uri.toString());
            if (browser_1.ExpandableTreeNode.is(node) && browser_1.SelectableTreeNode.is(node)) {
                this.model.expandNode(node);
                this.model.selectNode(node);
            }
        }
    }
    storeState() {
        // no-op
        return {};
    }
    superStoreState() {
        return super.storeState();
    }
    restoreState(state) {
        // no-op
    }
    superRestoreState(state) {
        super.restoreState(state);
        return;
    }
    tapNode(node) {
        super.tapNode(node);
        if (marker_tree_1.MarkerNode.is(node)) {
            this.model.revealNode(node);
        }
    }
    handleDown(event) {
        const node = this.model.getNextSelectableNode();
        super.handleDown(event);
        if (marker_tree_1.MarkerNode.is(node)) {
            this.model.revealNode(node);
        }
    }
    handleUp(event) {
        const node = this.model.getPrevSelectableNode();
        super.handleUp(event);
        if (marker_tree_1.MarkerNode.is(node)) {
            this.model.revealNode(node);
        }
    }
    renderTree(model) {
        if (marker_tree_1.MarkerRootNode.is(model.root) && model.root.children.length > 0) {
            return super.renderTree(model);
        }
        return (0, jsx_runtime_1.jsx)("div", { className: 'theia-widget-noInfo noMarkers', children: nls_1.nls.localize('theia/markers/noProblems', 'No problems have been detected in the workspace so far.') });
    }
    renderCaption(node, props) {
        if (marker_tree_1.MarkerInfoNode.is(node)) {
            return this.decorateMarkerFileNode(node);
        }
        else if (marker_tree_1.MarkerNode.is(node)) {
            return this.decorateMarkerNode(node);
        }
        return 'caption';
    }
    renderTailDecorations(node, props) {
        return (0, jsx_runtime_1.jsx)("div", { className: 'row-button-container', children: this.renderRemoveButton(node) });
    }
    renderRemoveButton(node) {
        return (0, jsx_runtime_1.jsx)(ProblemMarkerRemoveButton, { model: this.model, node: node });
    }
    getMarkerNodeFormatData(marker) {
        const line = marker.data.range.start.line + 1;
        const column = marker.data.range.start.character + 1;
        const location = nls_1.nls.localizeByDefault('Ln {0}, Col {1}', line, column);
        const severityClass = marker.data.severity ? this.getSeverityClass(marker.data.severity) : '';
        const severityLabel = marker.data.severity ? this.getSeverityLabel(marker.data.severity) : '';
        const source = marker.data.source ? `${marker.data.source}` : '';
        const code = marker.data.code ? `(${marker.data.code})` : '';
        return {
            severityClass,
            severityLabel,
            message: marker.data.message,
            line,
            column,
            location,
            source,
            code,
        };
    }
    decorateMarkerNode(node) {
        if (problem_marker_1.ProblemMarker.is(node.marker)) {
            const problemMarker = node.marker;
            const data = this.getMarkerNodeFormatData(problemMarker);
            return (0, jsx_runtime_1.jsxs)("div", { className: 'markerNode', title: `${data.message} (${data.line}, ${data.column})`, children: [(0, jsx_runtime_1.jsx)("div", { children: (0, jsx_runtime_1.jsx)("i", { className: `${data.severityClass} ${browser_1.TREE_NODE_INFO_CLASS}` }) }), (0, jsx_runtime_1.jsxs)("div", { className: 'message', children: [data.message, (!!data.source || !!data.code) &&
                                (0, jsx_runtime_1.jsxs)("span", { className: 'owner ' + browser_1.TREE_NODE_INFO_CLASS, children: [data.source || '', data.code || ''] }), (0, jsx_runtime_1.jsx)("span", { className: 'position ' + browser_1.TREE_NODE_INFO_CLASS, children: `[${data.location}]` })] })] });
        }
        return '';
    }
    formatMarkerNodeAsText(node) {
        const marker = node.marker;
        const data = this.getMarkerNodeFormatData(marker);
        const sourceCode = [data.source, data.code].filter(s => s).join(' ');
        const suffix = sourceCode ? ` ${sourceCode}` : '';
        return `${data.severityLabel}: ${data.message}${suffix} [${data.location}]`;
    }
    getSeverityLabel(severity) {
        switch (severity) {
            case vscode_languageserver_protocol_1.DiagnosticSeverity.Error: return nls_1.nls.localizeByDefault('Error');
            case vscode_languageserver_protocol_1.DiagnosticSeverity.Warning: return nls_1.nls.localizeByDefault('Warning');
            case vscode_languageserver_protocol_1.DiagnosticSeverity.Information: return nls_1.nls.localizeByDefault('Info');
            default: return nls_1.nls.localizeByDefault('Hint');
        }
    }
    getSeverityClass(severity) {
        switch (severity) {
            case vscode_languageserver_protocol_1.DiagnosticSeverity.Error: return `${(0, browser_1.codicon)('error')} error`;
            case vscode_languageserver_protocol_1.DiagnosticSeverity.Warning: return `${(0, browser_1.codicon)('warning')} warning`;
            case vscode_languageserver_protocol_1.DiagnosticSeverity.Information: return `${(0, browser_1.codicon)('info')} information`;
            default: return `${(0, browser_1.codicon)('thumbsup')} hint`;
        }
    }
    formatMarkerFileNodeAsText(node) {
        const name = this.toNodeName(node);
        const description = this.toNodeDescription(node);
        return description ? `${name} ${description}` : name;
    }
    decorateMarkerFileNode(node) {
        const icon = this.toNodeIcon(node);
        const name = this.toNodeName(node);
        const description = this.toNodeDescription(node);
        // Use a custom scheme so that we fallback to the `DefaultUriLabelProviderContribution`.
        const path = this.labelProvider.getLongName(node.uri.withScheme('marker'));
        return (0, jsx_runtime_1.jsxs)("div", { title: path, className: 'markerFileNode', children: [icon && (0, jsx_runtime_1.jsx)("div", { className: icon + ' file-icon' }), (0, jsx_runtime_1.jsx)("div", { className: 'name', children: name }), (0, jsx_runtime_1.jsx)("div", { className: 'path ' + browser_1.TREE_NODE_INFO_CLASS, children: description }), (0, jsx_runtime_1.jsx)("div", { className: 'notification-count-container', children: (0, jsx_runtime_1.jsx)("span", { className: 'notification-count', children: node.numberOfMarkers.toString() }) })] });
    }
};
exports.ProblemWidget = ProblemWidget;
tslib_1.__decorate([
    (0, inversify_1.inject)(problem_preferences_1.ProblemPreferences),
    tslib_1.__metadata("design:type", Object)
], ProblemWidget.prototype, "preferences", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.ApplicationShell),
    tslib_1.__metadata("design:type", browser_1.ApplicationShell)
], ProblemWidget.prototype, "shell", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(problem_manager_1.ProblemManager),
    tslib_1.__metadata("design:type", problem_manager_1.ProblemManager)
], ProblemWidget.prototype, "problemManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], ProblemWidget.prototype, "init", null);
exports.ProblemWidget = ProblemWidget = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__param(0, (0, inversify_1.inject)(browser_1.TreeProps)),
    tslib_1.__param(1, (0, inversify_1.inject)(problem_tree_model_1.ProblemTreeModel)),
    tslib_1.__param(2, (0, inversify_1.inject)(browser_1.ContextMenuRenderer)),
    tslib_1.__metadata("design:paramtypes", [Object, problem_tree_model_1.ProblemTreeModel,
        browser_1.ContextMenuRenderer])
], ProblemWidget);
class ProblemMarkerRemoveButton extends React.Component {
    constructor() {
        super(...arguments);
        this.remove = (e) => this.doRemove(e);
    }
    render() {
        return (0, jsx_runtime_1.jsx)("span", { className: (0, browser_1.codicon)('close'), onClick: this.remove });
    }
    doRemove(e) {
        this.props.model.removeNode(this.props.node);
        e.stopPropagation();
    }
}
exports.ProblemMarkerRemoveButton = ProblemMarkerRemoveButton;
//# sourceMappingURL=problem-widget.js.map