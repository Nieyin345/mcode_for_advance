"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotebookCellToolbarFactory = void 0;
const tslib_1 = require("tslib");
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
const core_1 = require("@theia/core");
const inversify_1 = require("@theia/core/shared/inversify");
const context_key_service_1 = require("@theia/core/lib/browser/context-key-service");
const notebook_cell_toolbar_1 = require("./notebook-cell-toolbar");
const browser_1 = require("@theia/core/lib/browser");
const notebook_context_manager_1 = require("../service/notebook-context-manager");
let NotebookCellToolbarFactory = class NotebookCellToolbarFactory {
    constructor() {
        this.onDidChangeContextEmitter = new core_1.Emitter;
        this.onDidChangeContext = this.onDidChangeContextEmitter.event;
        this.toDisposeOnRender = new core_1.DisposableCollection();
    }
    renderCellToolbar(menuPath, cell, itemOptions) {
        return (0, jsx_runtime_1.jsx)(notebook_cell_toolbar_1.NotebookCellToolbar, { getMenuItems: () => this.getMenuItems(menuPath, cell, itemOptions), onContextChanged: this.onDidChangeContext });
    }
    renderSidebar(menuPath, cell, itemOptions) {
        return (0, jsx_runtime_1.jsx)(notebook_cell_toolbar_1.NotebookCellSidebar, { getMenuItems: () => this.getMenuItems(menuPath, cell, itemOptions), onContextChanged: this.onDidChangeContext });
    }
    getMenuItems(menuItemPath, cell, itemOptions) {
        this.toDisposeOnRender.dispose();
        this.toDisposeOnRender = new core_1.DisposableCollection();
        const inlineItems = [];
        const menu = this.menuRegistry.getMenu(menuItemPath);
        this.toDisposeOnRender.push(this.notebookContextManager.scopedStore?.onDidChangeContext(() => {
            this.onDidChangeContextEmitter.fire();
        }));
        if (menu) {
            for (const menuNode of menu.children) {
                const itemPath = [...menuItemPath, menuNode.id];
                if (menuNode.isVisible(itemPath, this.notebookContextManager.getCellContext(cell.handle), this.notebookContextManager.context, itemOptions.commandArgs?.() ?? [])) {
                    if (core_1.RenderedMenuNode.is(menuNode)) {
                        inlineItems.push(this.createToolbarItem(itemPath, menuNode, itemOptions));
                    }
                }
            }
        }
        return inlineItems;
    }
    createToolbarItem(menuPath, menuNode, itemOptions) {
        return {
            id: menuNode.id,
            icon: menuNode.icon,
            label: menuNode.label,
            onClick: e => {
                if (core_1.CompoundMenuNode.is(menuNode)) {
                    this.contextMenuRenderer.render({
                        anchor: e.nativeEvent,
                        menuPath: menuPath,
                        menu: menuNode,
                        includeAnchorArg: false,
                        args: itemOptions.contextMenuArgs?.(),
                        context: this.notebookContextManager.context || e.currentTarget
                    });
                }
                else if (core_1.CommandMenu.is(menuNode)) {
                    menuNode.run(menuPath, ...(itemOptions.commandArgs?.() ?? []));
                }
                ;
            },
            isVisible: () => true
        };
    }
};
exports.NotebookCellToolbarFactory = NotebookCellToolbarFactory;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.MenuModelRegistry),
    tslib_1.__metadata("design:type", core_1.MenuModelRegistry)
], NotebookCellToolbarFactory.prototype, "menuRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(context_key_service_1.ContextKeyService),
    tslib_1.__metadata("design:type", Object)
], NotebookCellToolbarFactory.prototype, "contextKeyService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.ContextMenuRenderer),
    tslib_1.__metadata("design:type", browser_1.ContextMenuRenderer)
], NotebookCellToolbarFactory.prototype, "contextMenuRenderer", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.CommandRegistry),
    tslib_1.__metadata("design:type", core_1.CommandRegistry)
], NotebookCellToolbarFactory.prototype, "commandRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_context_manager_1.NotebookContextManager),
    tslib_1.__metadata("design:type", notebook_context_manager_1.NotebookContextManager)
], NotebookCellToolbarFactory.prototype, "notebookContextManager", void 0);
exports.NotebookCellToolbarFactory = NotebookCellToolbarFactory = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], NotebookCellToolbarFactory);
//# sourceMappingURL=notebook-cell-toolbar-factory.js.map