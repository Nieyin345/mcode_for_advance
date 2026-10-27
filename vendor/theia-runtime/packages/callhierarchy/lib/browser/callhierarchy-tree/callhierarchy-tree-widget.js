"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CallHierarchyTreeWidget = exports.DEFINITION_ICON_CLASS = exports.DEFINITION_NODE_CLASS = exports.HIERARCHY_TREE_CLASS = void 0;
const tslib_1 = require("tslib");
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
// *****************************************************************************
// Copyright (C) 2018 TypeFox and others.
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
const browser_1 = require("@theia/core/lib/browser");
const label_provider_1 = require("@theia/core/lib/browser/label-provider");
const callhierarchy_tree_1 = require("./callhierarchy-tree");
const callhierarchy_tree_model_1 = require("./callhierarchy-tree-model");
const callhierarchy_1 = require("../callhierarchy");
const uri_1 = require("@theia/core/lib/common/uri");
const vscode_languageserver_protocol_1 = require("@theia/core/shared/vscode-languageserver-protocol");
const browser_2 = require("@theia/editor/lib/browser");
const nls_1 = require("@theia/core/lib/common/nls");
exports.HIERARCHY_TREE_CLASS = 'theia-CallHierarchyTree';
exports.DEFINITION_NODE_CLASS = 'theia-CallHierarchyTreeNode';
exports.DEFINITION_ICON_CLASS = 'theia-CallHierarchyTreeNodeIcon';
let CallHierarchyTreeWidget = class CallHierarchyTreeWidget extends browser_1.TreeWidget {
    constructor(props, model, contextMenuRenderer, labelProvider, editorManager) {
        super(props, model, contextMenuRenderer);
        this.props = props;
        this.model = model;
        this.labelProvider = labelProvider;
        this.editorManager = editorManager;
        this.id = callhierarchy_1.CALLHIERARCHY_ID;
        this.title.label = callhierarchy_1.CALL_HIERARCHY_LABEL;
        this.title.caption = callhierarchy_1.CALL_HIERARCHY_LABEL;
        this.title.iconClass = (0, browser_1.codicon)('references');
        this.title.closable = true;
        this.addClass(exports.HIERARCHY_TREE_CLASS);
        this.toDispose.push(this.model.onSelectionChanged(selection => {
            const node = selection[0];
            if (node) {
                this.openEditor(node, true);
            }
        }));
        this.toDispose.push(this.model.onOpenNode((node) => {
            this.openEditor(node, false);
        }));
        this.toDispose.push(this.labelProvider.onDidChange(() => this.update()));
    }
    initializeModel(selection, languageId) {
        this.model.initializeCallHierarchy(languageId, selection ? selection.uri : undefined, selection ? selection.range.start : undefined);
    }
    createNodeClassNames(node, props) {
        const classNames = super.createNodeClassNames(node, props);
        if (callhierarchy_tree_1.ItemNode.is(node)) {
            classNames.push(exports.DEFINITION_NODE_CLASS);
        }
        return classNames;
    }
    createNodeAttributes(node, props) {
        const elementAttrs = super.createNodeAttributes(node, props);
        return {
            ...elementAttrs,
        };
    }
    renderTree(model) {
        return super.renderTree(model)
            || (0, jsx_runtime_1.jsx)("div", { className: 'theia-widget-noInfo', children: nls_1.nls.localize('theia/callhierarchy/noCallers', 'No callers have been detected.') });
    }
    renderCaption(node, props) {
        if (callhierarchy_tree_1.ItemNode.is(node)) {
            return this.decorateDefinitionCaption(node.definition);
        }
        if (callhierarchy_tree_1.CallerNode.is(node)) {
            return this.decorateCallerCaption(node.caller);
        }
        return 'caption';
    }
    decorateDefinitionCaption(definition) {
        const symbol = definition.name;
        const location = this.labelProvider.getName(uri_1.default.fromComponents(definition.uri));
        const container = location;
        const isDeprecated = definition.tags?.includes(vscode_languageserver_protocol_1.SymbolTag.Deprecated);
        const classNames = ['definitionNode'];
        if (isDeprecated) {
            classNames.push('deprecatedDefinition');
        }
        return (0, jsx_runtime_1.jsxs)("div", { className: classNames.join(' '), children: [(0, jsx_runtime_1.jsx)("div", { className: 'symbol-icon-center codicon codicon-symbol-' + this.toIconClass(definition.kind) }), (0, jsx_runtime_1.jsxs)("div", { className: 'definitionNode-content', children: [(0, jsx_runtime_1.jsx)("span", { className: 'symbol', children: symbol }), (0, jsx_runtime_1.jsx)("span", { className: 'container', children: container })] })] });
    }
    decorateCallerCaption(caller) {
        const definition = caller.from;
        const symbol = definition.name;
        const referenceCount = caller.fromRanges.length;
        const location = this.labelProvider.getName(uri_1.default.fromComponents(definition.uri));
        const container = location;
        const isDeprecated = definition.tags?.includes(vscode_languageserver_protocol_1.SymbolTag.Deprecated);
        const classNames = ['definitionNode'];
        if (isDeprecated) {
            classNames.push('deprecatedDefinition');
        }
        return (0, jsx_runtime_1.jsxs)("div", { className: classNames.join(' '), children: [(0, jsx_runtime_1.jsx)("div", { className: 'symbol-icon-center codicon codicon-symbol-' + this.toIconClass(definition.kind) }), (0, jsx_runtime_1.jsxs)("div", { className: 'definitionNode-content', children: [(0, jsx_runtime_1.jsx)("span", { className: 'symbol', children: symbol }), (0, jsx_runtime_1.jsx)("span", { className: 'referenceCount', children: (referenceCount > 1) ? `[${referenceCount}]` : '' }), (0, jsx_runtime_1.jsx)("span", { className: 'container', children: container })] })] });
    }
    // tslint:disable-next-line:typedef
    toIconClass(symbolKind) {
        switch (symbolKind) {
            case vscode_languageserver_protocol_1.SymbolKind.File: return 'file';
            case vscode_languageserver_protocol_1.SymbolKind.Module: return 'module';
            case vscode_languageserver_protocol_1.SymbolKind.Namespace: return 'namespace';
            case vscode_languageserver_protocol_1.SymbolKind.Package: return 'package';
            case vscode_languageserver_protocol_1.SymbolKind.Class: return 'class';
            case vscode_languageserver_protocol_1.SymbolKind.Method: return 'method';
            case vscode_languageserver_protocol_1.SymbolKind.Property: return 'property';
            case vscode_languageserver_protocol_1.SymbolKind.Field: return 'field';
            case vscode_languageserver_protocol_1.SymbolKind.Constructor: return 'constructor';
            case vscode_languageserver_protocol_1.SymbolKind.Enum: return 'enum';
            case vscode_languageserver_protocol_1.SymbolKind.Interface: return 'interface';
            case vscode_languageserver_protocol_1.SymbolKind.Function: return 'function';
            case vscode_languageserver_protocol_1.SymbolKind.Variable: return 'variable';
            case vscode_languageserver_protocol_1.SymbolKind.Constant: return 'constant';
            case vscode_languageserver_protocol_1.SymbolKind.String: return 'string';
            case vscode_languageserver_protocol_1.SymbolKind.Number: return 'number';
            case vscode_languageserver_protocol_1.SymbolKind.Boolean: return 'boolean';
            case vscode_languageserver_protocol_1.SymbolKind.Array: return 'array';
            default: return 'unknown';
        }
    }
    openEditor(node, keepFocus) {
        if (callhierarchy_tree_1.ItemNode.is(node)) {
            const def = node.definition;
            this.doOpenEditor(uri_1.default.fromComponents(def.uri).toString(), def.selectionRange ? def.selectionRange : def.range, keepFocus);
        }
        if (callhierarchy_tree_1.CallerNode.is(node)) {
            this.doOpenEditor(uri_1.default.fromComponents(node.caller.from.uri).toString(), node.caller.fromRanges[0], keepFocus);
        }
    }
    doOpenEditor(uri, range, keepFocus) {
        this.editorManager.open(new uri_1.default(uri), {
            mode: keepFocus ? 'reveal' : 'activate',
            selection: range
        }).then(editorWidget => {
            if (editorWidget.parent instanceof browser_1.DockPanel) {
                editorWidget.parent.selectWidget(editorWidget);
            }
        });
    }
    storeState() {
        const callHierarchyService = this.model.getTree().callHierarchyService;
        if (this.model.root && callHierarchyService) {
            return {
                root: this.deflateForStorage(this.model.root),
                languageId: this.model.languageId,
            };
        }
        else {
            return {};
        }
    }
    restoreState(oldState) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (oldState.root && oldState.languageId) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const root = this.inflateFromStorage(oldState.root);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            this.model.initializeCallHierarchy(oldState.languageId, uri_1.default.fromComponents(root.definition.uri).toString(), root.definition.range.start);
        }
    }
};
exports.CallHierarchyTreeWidget = CallHierarchyTreeWidget;
exports.CallHierarchyTreeWidget = CallHierarchyTreeWidget = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__param(0, (0, inversify_1.inject)(browser_1.TreeProps)),
    tslib_1.__param(1, (0, inversify_1.inject)(callhierarchy_tree_model_1.CallHierarchyTreeModel)),
    tslib_1.__param(2, (0, inversify_1.inject)(browser_1.ContextMenuRenderer)),
    tslib_1.__param(3, (0, inversify_1.inject)(label_provider_1.LabelProvider)),
    tslib_1.__param(4, (0, inversify_1.inject)(browser_2.EditorManager)),
    tslib_1.__metadata("design:paramtypes", [Object, callhierarchy_tree_model_1.CallHierarchyTreeModel,
        browser_1.ContextMenuRenderer,
        label_provider_1.LabelProvider,
        browser_2.EditorManager])
], CallHierarchyTreeWidget);
//# sourceMappingURL=callhierarchy-tree-widget.js.map