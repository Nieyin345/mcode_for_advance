"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotebookMainToolbar = exports.NotebookMainToolbarRenderer = void 0;
const tslib_1 = require("tslib");
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
// *****************************************************************************
// Copyright (C) 2023 TypeFox and others.
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
const core_1 = require("@theia/core");
const React = require("@theia/core/shared/react");
const browser_1 = require("@theia/core/lib/browser");
const notebook_actions_contribution_1 = require("../contributions/notebook-actions-contribution");
const notebook_kernel_service_1 = require("../service/notebook-kernel-service");
const inversify_1 = require("@theia/core/shared/inversify");
const context_key_service_1 = require("@theia/core/lib/browser/context-key-service");
const notebook_context_manager_1 = require("../service/notebook-context-manager");
let NotebookMainToolbarRenderer = class NotebookMainToolbarRenderer {
    render(notebookModel, editorNode) {
        return (0, jsx_runtime_1.jsx)(NotebookMainToolbar, { notebookModel: notebookModel, menuRegistry: this.menuRegistry, notebookKernelService: this.notebookKernelService, commandRegistry: this.commandRegistry, contextKeyService: this.contextKeyService, editorNode: editorNode, notebookContextManager: this.notebookContextManager, contextMenuRenderer: this.contextMenuRenderer });
    }
};
exports.NotebookMainToolbarRenderer = NotebookMainToolbarRenderer;
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_kernel_service_1.NotebookKernelService),
    tslib_1.__metadata("design:type", notebook_kernel_service_1.NotebookKernelService)
], NotebookMainToolbarRenderer.prototype, "notebookKernelService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.CommandRegistry),
    tslib_1.__metadata("design:type", core_1.CommandRegistry)
], NotebookMainToolbarRenderer.prototype, "commandRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.MenuModelRegistry),
    tslib_1.__metadata("design:type", core_1.MenuModelRegistry)
], NotebookMainToolbarRenderer.prototype, "menuRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(context_key_service_1.ContextKeyService),
    tslib_1.__metadata("design:type", Object)
], NotebookMainToolbarRenderer.prototype, "contextKeyService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_context_manager_1.NotebookContextManager),
    tslib_1.__metadata("design:type", notebook_context_manager_1.NotebookContextManager)
], NotebookMainToolbarRenderer.prototype, "notebookContextManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.ContextMenuRenderer),
    tslib_1.__metadata("design:type", browser_1.ContextMenuRenderer)
], NotebookMainToolbarRenderer.prototype, "contextMenuRenderer", void 0);
exports.NotebookMainToolbarRenderer = NotebookMainToolbarRenderer = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], NotebookMainToolbarRenderer);
class NotebookMainToolbar extends React.Component {
    // The minimum area between items and kernel select before hiding items in a context menu
    static { this.MIN_FREE_AREA = 10; }
    constructor(props) {
        super(props);
        this.toDispose = new core_1.DisposableCollection();
        this.nativeSubmenus = [
            notebook_actions_contribution_1.NotebookMenus.NOTEBOOK_MAIN_TOOLBAR_CELL_ADD_GROUP[notebook_actions_contribution_1.NotebookMenus.NOTEBOOK_MAIN_TOOLBAR_CELL_ADD_GROUP.length - 1],
            notebook_actions_contribution_1.NotebookMenus.NOTEBOOK_MAIN_TOOLBAR_EXECUTION_GROUP[notebook_actions_contribution_1.NotebookMenus.NOTEBOOK_MAIN_TOOLBAR_EXECUTION_GROUP.length - 1]
        ];
        this.lastGapElementWidth = 0;
        this.resizeObserver = new ResizeObserver(() => this.calculateItemsToHide());
        this.state = {
            selectedKernelLabel: props.notebookKernelService.getSelectedOrSuggestedKernel(props.notebookModel)?.label,
            numberOfHiddenItems: 0,
        };
        this.toDispose.push(props.notebookKernelService.onDidChangeSelectedKernel(event => {
            if (props.notebookModel.uri.isEqual(event.notebook)) {
                this.setState({ selectedKernelLabel: props.notebookKernelService.getKernel(event.newKernel ?? '')?.label });
            }
        }));
        // in case the selected kernel is added after the notebook is loaded
        this.toDispose.push(props.notebookKernelService.onDidAddKernel(() => {
            if (!this.state.selectedKernelLabel) {
                this.setState({ selectedKernelLabel: props.notebookKernelService.getSelectedOrSuggestedKernel(props.notebookModel)?.label });
            }
        }));
        // TODO maybe we need a mechanism to check for changes in the menu to update this toolbar
        const menuItems = this.getMenuItems();
        for (const item of menuItems) {
            if (item.onDidChange) {
                item.onDidChange(() => this.forceUpdate());
            }
        }
    }
    componentWillUnmount() {
        this.toDispose.dispose();
    }
    componentDidUpdate() {
        this.calculateItemsToHide();
    }
    componentDidMount() {
        this.calculateItemsToHide();
    }
    calculateItemsToHide() {
        const numberOfMenuItems = this.getMenuItems().length;
        if (this.gapElement && this.gapElement.getBoundingClientRect().width < NotebookMainToolbar.MIN_FREE_AREA && this.state.numberOfHiddenItems < numberOfMenuItems) {
            this.setState({ ...this.state, numberOfHiddenItems: this.state.numberOfHiddenItems + 1 });
            this.lastGapElementWidth = this.gapElement.getBoundingClientRect().width;
        }
        else if (this.gapElement && this.gapElement.getBoundingClientRect().width > this.lastGapElementWidth && this.state.numberOfHiddenItems > 0) {
            this.setState({ ...this.state, numberOfHiddenItems: 0 });
            this.lastGapElementWidth = this.gapElement.getBoundingClientRect().width;
        }
    }
    renderContextMenu(event, menuItems) {
        const hiddenItems = menuItems.slice(menuItems.length - this.calculateNumberOfHiddenItems(menuItems));
        const menu = new core_1.GroupImpl(notebook_actions_contribution_1.NotebookMenus.NOTEBOOK_MAIN_TOOLBAR_HIDDEN_ITEMS_CONTEXT_MENU[0]);
        hiddenItems.forEach(item => menu.addNode(item));
        this.props.contextMenuRenderer.render({
            anchor: event,
            menuPath: notebook_actions_contribution_1.NotebookMenus.NOTEBOOK_MAIN_TOOLBAR_HIDDEN_ITEMS_CONTEXT_MENU,
            menu: menu,
            contextKeyService: this.props.contextKeyService,
            context: this.props.editorNode,
            args: [this.props.notebookModel.uri]
        });
    }
    render() {
        const menuItems = this.getMenuItems();
        return (0, jsx_runtime_1.jsxs)("div", { className: 'theia-notebook-main-toolbar', id: 'notebook-main-toolbar', children: [menuItems.slice(0, menuItems.length - this.calculateNumberOfHiddenItems(menuItems)).map(item => this.renderMenuItem(notebook_actions_contribution_1.NotebookMenus.NOTEBOOK_MAIN_TOOLBAR, item)), this.state.numberOfHiddenItems > 0 &&
                    (0, jsx_runtime_1.jsx)("span", { className: `${(0, browser_1.codicon)('ellipsis')} action-label theia-notebook-main-toolbar-item`, onClick: e => this.renderContextMenu(e.nativeEvent, menuItems) }), (0, jsx_runtime_1.jsx)("div", { ref: element => this.gapElementChanged(element), style: { flexGrow: 1 } }), (0, jsx_runtime_1.jsxs)("div", { className: 'theia-notebook-main-toolbar-item action-label', id: notebook_actions_contribution_1.NotebookCommands.SELECT_KERNEL_COMMAND.id, onClick: () => this.props.commandRegistry.executeCommand(notebook_actions_contribution_1.NotebookCommands.SELECT_KERNEL_COMMAND.id, this.props.notebookModel), children: [(0, jsx_runtime_1.jsx)("span", { className: (0, browser_1.codicon)('server-environment') }), (0, jsx_runtime_1.jsx)("span", { className: ' theia-notebook-main-toolbar-item-text', id: 'kernel-text', children: this.state.selectedKernelLabel ?? core_1.nls.localizeByDefault('Select Kernel') })] })] });
    }
    gapElementChanged(element) {
        if (this.gapElement) {
            this.resizeObserver.unobserve(this.gapElement);
        }
        this.gapElement = element ?? undefined;
        if (this.gapElement) {
            this.lastGapElementWidth = this.gapElement.getBoundingClientRect().width;
            this.resizeObserver.observe(this.gapElement);
        }
    }
    renderMenuItem(itemPath, item, submenu) {
        if (core_1.Group.is(item)) {
            const itemNodes = core_1.ArrayUtils.coalesce(item.children?.map(child => this.renderMenuItem([...itemPath, child.id], child, item.id)) ?? []);
            return (0, jsx_runtime_1.jsxs)(React.Fragment, { children: [itemNodes, itemNodes && itemNodes.length > 0 && (0, jsx_runtime_1.jsx)("span", { className: 'theia-notebook-toolbar-separator' }, `${item.id}-separator`)] }, item.id);
        }
        else if (core_1.CommandMenu.is(item) && ((this.nativeSubmenus.includes(submenu ?? '')) || item.isVisible(itemPath, this.props.contextKeyService, this.props.editorNode))) {
            return (0, jsx_runtime_1.jsxs)("div", { id: item.id, title: item.label, className: `theia-notebook-main-toolbar-item action-label${this.getAdditionalClasses(itemPath, item)}`, onClick: () => {
                    item.run(itemPath, this.props.notebookModel.uri);
                }, children: [(0, jsx_runtime_1.jsx)("span", { className: item.icon }), (0, jsx_runtime_1.jsx)("span", { className: 'theia-notebook-main-toolbar-item-text', children: item.label })] }, item.id);
        }
        return undefined;
    }
    getMenuItems() {
        return this.props.menuRegistry.getMenu(notebook_actions_contribution_1.NotebookMenus.NOTEBOOK_MAIN_TOOLBAR).children; // we contribute to this menu, so it exists
    }
    getAdditionalClasses(itemPath, item) {
        return item.isEnabled(itemPath, this.props.editorNode) ? '' : ' theia-mod-disabled';
    }
    calculateNumberOfHiddenItems(allMenuItems) {
        return this.state.numberOfHiddenItems >= allMenuItems.length ?
            allMenuItems.length :
            this.state.numberOfHiddenItems % allMenuItems.length;
    }
}
exports.NotebookMainToolbar = NotebookMainToolbar;
//# sourceMappingURL=notebook-main-toolbar.js.map