"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MergeEditorPaneHeader = void 0;
const tslib_1 = require("tslib");
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
// *****************************************************************************
// Copyright (C) 2025 1C-Soft LLC and others.
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
const React = require("@theia/core/shared/react");
const browser_1 = require("@theia/core/lib/browser");
const label_parser_1 = require("@theia/core/lib/browser/label-parser");
let MergeEditorPaneHeader = class MergeEditorPaneHeader extends browser_1.ReactWidget {
    constructor() {
        super(...arguments);
        this._description = '';
        this._detail = '';
        this.handleToolbarClick = (event) => event.nativeEvent.stopImmediatePropagation();
    }
    get description() {
        return this._description;
    }
    set description(description) {
        this._description = description;
        this.update();
    }
    get detail() {
        return this._detail;
    }
    set detail(detail) {
        this._detail = detail;
        this.update();
    }
    get toolbarItems() {
        return this._toolbarItems;
    }
    set toolbarItems(toolbarItems) {
        this._toolbarItems = toolbarItems;
        this.update();
    }
    init() {
        this.addClass('header');
        this.scrollOptions = undefined;
        this.node.tabIndex = -1;
        this.toDispose.push((0, browser_1.onDomEvent)(this.node, 'click', () => this.activate()));
        this.title.changed.connect(this.update, this);
    }
    onActivateRequest(msg) {
        super.onActivateRequest(msg);
        this.parent?.activate();
    }
    render() {
        return ((0, jsx_runtime_1.jsxs)(React.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { className: 'title', children: this.renderWithIcons(this.title.label) }), (0, jsx_runtime_1.jsx)("span", { className: 'description', children: this.renderWithIcons(this.description) }), (0, jsx_runtime_1.jsx)("span", { className: 'detail', children: this.renderWithIcons(this.detail) }), (0, jsx_runtime_1.jsx)("span", { className: 'toolbar', onClick: this.handleToolbarClick, children: this.toolbarItems.map(toolbarItem => this.renderToolbarItem(toolbarItem)) })] }));
    }
    renderWithIcons(text) {
        const result = [];
        const labelParts = this.labelParser.parse(text);
        labelParts.forEach((labelPart, index) => {
            if (typeof labelPart === 'string') {
                result.push(labelPart);
            }
            else {
                result.push((0, jsx_runtime_1.jsx)("span", { className: (0, browser_1.codicon)(labelPart.name) }, index));
            }
        });
        return result;
    }
    renderToolbarItem({ id, label, tooltip, className, onClick }) {
        return (0, jsx_runtime_1.jsx)("span", { title: tooltip, onClick: onClick, className: className, children: label }, id);
    }
};
exports.MergeEditorPaneHeader = MergeEditorPaneHeader;
tslib_1.__decorate([
    (0, inversify_1.inject)(label_parser_1.LabelParser),
    tslib_1.__metadata("design:type", label_parser_1.LabelParser)
], MergeEditorPaneHeader.prototype, "labelParser", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], MergeEditorPaneHeader.prototype, "init", null);
exports.MergeEditorPaneHeader = MergeEditorPaneHeader = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MergeEditorPaneHeader);
//# sourceMappingURL=merge-editor-pane-header.js.map