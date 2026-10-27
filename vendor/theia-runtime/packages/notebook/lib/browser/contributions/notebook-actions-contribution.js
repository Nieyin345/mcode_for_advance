"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotebookMenus = exports.NotebookActionsContribution = exports.CellChangeDirection = exports.NotebookCommands = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const inversify_1 = require("@theia/core/shared/inversify");
const browser_1 = require("@theia/core/lib/browser");
const notebook_service_1 = require("../service/notebook-service");
const common_1 = require("../../common");
const notebook_kernel_quick_pick_service_1 = require("../service/notebook-kernel-quick-pick-service");
const notebook_execution_service_1 = require("../service/notebook-execution-service");
const notebook_editor_widget_service_1 = require("../service/notebook-editor-widget-service");
const notebook_context_keys_1 = require("./notebook-context-keys");
const notebook_clipboard_service_1 = require("../service/notebook-clipboard-service");
const context_key_service_1 = require("@theia/core/lib/browser/context-key-service");
var NotebookCommands;
(function (NotebookCommands) {
    NotebookCommands.ADD_NEW_CELL_COMMAND = core_1.Command.toDefaultLocalizedCommand({
        id: 'notebook.add-new-cell',
        iconClass: (0, browser_1.codicon)('add')
    });
    NotebookCommands.ADD_NEW_MARKDOWN_CELL_COMMAND = core_1.Command.toDefaultLocalizedCommand({
        id: 'notebook.add-new-markdown-cell',
        iconClass: (0, browser_1.codicon)('add'),
        tooltip: core_1.nls.localizeByDefault('Add Markdown Cell')
    });
    NotebookCommands.ADD_NEW_CODE_CELL_COMMAND = core_1.Command.toDefaultLocalizedCommand({
        id: 'notebook.add-new-code-cell',
        iconClass: (0, browser_1.codicon)('add'),
        tooltip: core_1.nls.localizeByDefault('Add Code Cell')
    });
    NotebookCommands.SELECT_KERNEL_COMMAND = core_1.Command.toDefaultLocalizedCommand({
        id: 'notebook.selectKernel',
        category: 'Notebook',
        iconClass: (0, browser_1.codicon)('server-environment')
    });
    NotebookCommands.EXECUTE_NOTEBOOK_COMMAND = core_1.Command.toDefaultLocalizedCommand({
        id: 'notebook.execute',
        category: 'Notebook',
        iconClass: (0, browser_1.codicon)('run-all')
    });
    NotebookCommands.CLEAR_ALL_OUTPUTS_COMMAND = core_1.Command.toDefaultLocalizedCommand({
        id: 'notebook.clear-all-outputs',
        category: 'Notebook',
        iconClass: (0, browser_1.codicon)('clear-all')
    });
    NotebookCommands.CHANGE_SELECTED_CELL = core_1.Command.toDefaultLocalizedCommand({
        id: 'notebook.change-selected-cell',
        category: 'Notebook',
    });
    NotebookCommands.CUT_SELECTED_CELL = core_1.Command.toDefaultLocalizedCommand({
        id: 'notebook.cell.cut',
        category: 'Notebook',
    });
    NotebookCommands.COPY_SELECTED_CELL = core_1.Command.toDefaultLocalizedCommand({
        id: 'notebook.cell.copy',
        category: 'Notebook',
    });
    NotebookCommands.PASTE_CELL = core_1.Command.toDefaultLocalizedCommand({
        id: 'notebook.cell.paste',
        category: 'Notebook',
    });
    NotebookCommands.NOTEBOOK_FIND = core_1.Command.toDefaultLocalizedCommand({
        id: 'notebook.find',
        category: 'Notebook',
    });
    NotebookCommands.CENTER_ACTIVE_CELL = core_1.Command.toDefaultLocalizedCommand({
        id: 'notebook.centerActiveCell',
        category: 'Notebook',
    });
})(NotebookCommands || (exports.NotebookCommands = NotebookCommands = {}));
var CellChangeDirection;
(function (CellChangeDirection) {
    CellChangeDirection["Up"] = "up";
    CellChangeDirection["Down"] = "down";
})(CellChangeDirection || (exports.CellChangeDirection = CellChangeDirection = {}));
let NotebookActionsContribution = class NotebookActionsContribution {
    registerCommands(commands) {
        commands.registerCommand(NotebookCommands.ADD_NEW_CELL_COMMAND, {
            execute: (notebookModel, cellKind = common_1.CellKind.Markup, index, focusContainer) => {
                notebookModel = notebookModel ?? this.notebookEditorWidgetService.focusedEditor?.model;
                const viewModel = this.notebookEditorWidgetService.focusedEditor?.viewModel;
                let insertIndex = 0;
                if (typeof index === 'number' && index >= 0) {
                    insertIndex = index;
                }
                else if (viewModel?.selectedCell && typeof index === 'string') {
                    // if index is -1 insert below otherwise at the index of the selected cell which is above the selected.
                    insertIndex = notebookModel.cells.indexOf(viewModel.selectedCell) + (index === 'below' ? 1 : 0);
                }
                let cellLanguage = 'markdown';
                if (cellKind === common_1.CellKind.Code) {
                    cellLanguage = this.notebookService.getCodeCellLanguage(notebookModel);
                }
                notebookModel.applyEdits([{
                        editType: 1 /* CellEditType.Replace */,
                        index: insertIndex,
                        count: 0,
                        cells: [{
                                cellKind,
                                language: cellLanguage,
                                source: '',
                                outputs: [],
                                metadata: {},
                            }]
                    }], true);
                if (focusContainer) {
                    viewModel?.cellViewModels.get(viewModel.selectedCell?.handle ?? -1)?.requestBlurEditor();
                }
            }
        });
        commands.registerCommand(NotebookCommands.ADD_NEW_MARKDOWN_CELL_COMMAND, this.editableCommandHandler(notebookModel => commands.executeCommand(NotebookCommands.ADD_NEW_CELL_COMMAND.id, notebookModel, common_1.CellKind.Markup, 'below')));
        commands.registerCommand(NotebookCommands.ADD_NEW_CODE_CELL_COMMAND, this.editableCommandHandler(notebookModel => commands.executeCommand(NotebookCommands.ADD_NEW_CELL_COMMAND.id, notebookModel, common_1.CellKind.Code, 'below')));
        commands.registerCommand(NotebookCommands.SELECT_KERNEL_COMMAND, this.editableCommandHandler(notebookModel => this.notebookKernelQuickPickService.showQuickPick(notebookModel)));
        commands.registerCommand(NotebookCommands.EXECUTE_NOTEBOOK_COMMAND, this.editableCommandHandler(notebookModel => this.notebookExecutionService.executeNotebookCells(notebookModel, notebookModel.cells)));
        commands.registerCommand(NotebookCommands.CLEAR_ALL_OUTPUTS_COMMAND, this.editableCommandHandler(notebookModel => notebookModel.applyEdits(notebookModel.cells.map(cell => ({
            editType: 2 /* CellEditType.Output */,
            handle: cell.handle, deleteCount: cell.outputs.length, outputs: []
        })), false)));
        commands.registerCommand(NotebookCommands.CHANGE_SELECTED_CELL, {
            execute: (change) => {
                const focusedEditor = this.notebookEditorWidgetService.focusedEditor;
                const model = focusedEditor?.model;
                const viewModel = focusedEditor?.viewModel;
                if (model && typeof change === 'number') {
                    viewModel?.setSelectedCell(model.cells[change]);
                }
                else if (model && viewModel?.selectedCell) {
                    const currentIndex = model.cells.indexOf(viewModel?.selectedCell);
                    const shouldFocusEditor = this.contextKeyService.match('editorTextFocus');
                    if (change === CellChangeDirection.Up && currentIndex > 0) {
                        viewModel?.setSelectedCell(model.cells[currentIndex - 1]);
                        if ((viewModel?.selectedCell?.cellKind === common_1.CellKind.Code
                            || (viewModel?.selectedCell?.cellKind === common_1.CellKind.Markup && viewModel?.selectedCellViewModel?.editing)) && shouldFocusEditor) {
                            viewModel?.cellViewModels.get(viewModel.selectedCell.handle)?.requestFocusEditor('lastLine');
                        }
                    }
                    else if (change === CellChangeDirection.Down && currentIndex < model.cells.length - 1) {
                        viewModel?.setSelectedCell(model.cells[currentIndex + 1]);
                        if ((viewModel?.selectedCell?.cellKind === common_1.CellKind.Code
                            || (viewModel?.selectedCell?.cellKind === common_1.CellKind.Markup && viewModel?.selectedCellViewModel?.editing)) && shouldFocusEditor) {
                            viewModel?.cellViewModels.get(viewModel.selectedCell.handle)?.requestFocusEditor();
                        }
                    }
                    if (viewModel?.selectedCell.cellKind === common_1.CellKind.Markup) {
                        // since were losing focus from the cell editor, we need to focus the notebook editor again
                        focusedEditor?.node.focus();
                    }
                }
            }
        });
        commands.registerCommand({ id: 'list.focusUp' }, {
            execute: () => commands.executeCommand(NotebookCommands.CHANGE_SELECTED_CELL.id, CellChangeDirection.Up)
        });
        commands.registerCommand({ id: 'list.focusDown' }, {
            execute: () => commands.executeCommand(NotebookCommands.CHANGE_SELECTED_CELL.id, CellChangeDirection.Down)
        });
        commands.registerCommand(NotebookCommands.CUT_SELECTED_CELL, this.editableCommandHandler(() => {
            const model = this.notebookEditorWidgetService.focusedEditor?.model;
            const selectedCell = this.notebookEditorWidgetService.focusedEditor?.viewModel?.selectedCell;
            if (selectedCell && model) {
                model.applyEdits([{ editType: 1 /* CellEditType.Replace */, index: model.cells.indexOf(selectedCell), count: 1, cells: [] }], true);
                this.notebookClipboardService.copyCell(selectedCell);
            }
        }));
        commands.registerCommand(NotebookCommands.COPY_SELECTED_CELL, {
            execute: () => {
                const viewModel = this.notebookEditorWidgetService.focusedEditor?.viewModel;
                const selectedCell = viewModel?.selectedCell;
                if (selectedCell) {
                    this.notebookClipboardService.copyCell(selectedCell);
                }
            }
        });
        commands.registerCommand(NotebookCommands.PASTE_CELL, {
            isEnabled: () => !Boolean(this.notebookEditorWidgetService.focusedEditor?.model?.readOnly),
            isVisible: () => !Boolean(this.notebookEditorWidgetService.focusedEditor?.model?.readOnly),
            execute: (position) => {
                const copiedCell = this.notebookClipboardService.getCell();
                if (copiedCell) {
                    const model = this.notebookEditorWidgetService.focusedEditor?.model;
                    const viewModel = this.notebookEditorWidgetService.focusedEditor?.viewModel;
                    const insertIndex = viewModel?.selectedCell && model ? model.cells.indexOf(viewModel?.selectedCell) + (position === 'above' ? 0 : 1) : 0;
                    model?.applyEdits([{ editType: 1 /* CellEditType.Replace */, index: insertIndex, count: 0, cells: [copiedCell] }], true);
                }
            }
        });
        commands.registerCommand(NotebookCommands.NOTEBOOK_FIND, {
            execute: () => {
                this.notebookEditorWidgetService.focusedEditor?.showFindWidget();
            }
        });
        commands.registerCommand(NotebookCommands.CENTER_ACTIVE_CELL, {
            execute: (editor) => {
                const viewModel = editor ? editor.viewModel : this.notebookEditorWidgetService.focusedEditor?.viewModel;
                viewModel?.selectedCell?.requestCenterEditor();
            }
        });
    }
    editableCommandHandler(execute) {
        return {
            isEnabled: (item) => this.withModel(item, model => !Boolean(model?.readOnly), false),
            isVisible: (item) => this.withModel(item, model => !Boolean(model?.readOnly), false),
            execute: (uri) => {
                this.withModel(uri, execute, undefined);
            }
        };
    }
    withModel(item, execute, defaultValue) {
        if (item instanceof core_1.URI) {
            const model = this.notebookService.getNotebookEditorModel(item);
            if (!model) {
                return defaultValue;
            }
            item = model;
        }
        return execute(item);
    }
    registerMenus(menus) {
        // independent submenu for plugins to add commands
        menus.registerSubmenu(NotebookMenus.NOTEBOOK_MAIN_TOOLBAR, 'Notebook Main Toolbar');
        // Add Notebook Cell items
        menus.registerMenuAction(NotebookMenus.NOTEBOOK_MAIN_TOOLBAR_CELL_ADD_GROUP, {
            commandId: NotebookCommands.ADD_NEW_CODE_CELL_COMMAND.id,
            label: core_1.nls.localizeByDefault('Code'),
            icon: (0, browser_1.codicon)('add'),
        });
        menus.registerMenuAction(NotebookMenus.NOTEBOOK_MAIN_TOOLBAR_CELL_ADD_GROUP, {
            commandId: NotebookCommands.ADD_NEW_MARKDOWN_CELL_COMMAND.id,
            label: core_1.nls.localizeByDefault('Markdown'),
            icon: (0, browser_1.codicon)('add'),
        });
        // Execution related items
        menus.registerMenuAction(NotebookMenus.NOTEBOOK_MAIN_TOOLBAR_EXECUTION_GROUP, {
            commandId: NotebookCommands.EXECUTE_NOTEBOOK_COMMAND.id,
            label: core_1.nls.localizeByDefault('Run All'),
            icon: (0, browser_1.codicon)('run-all'),
            order: '10'
        });
        menus.registerMenuAction(NotebookMenus.NOTEBOOK_MAIN_TOOLBAR_EXECUTION_GROUP, {
            commandId: NotebookCommands.CLEAR_ALL_OUTPUTS_COMMAND.id,
            label: core_1.nls.localizeByDefault('Clear All Outputs'),
            icon: (0, browser_1.codicon)('clear-all'),
            order: '30',
            when: notebook_context_keys_1.NOTEBOOK_HAS_OUTPUTS
        });
        menus.registerSubmenu(NotebookMenus.NOTEBOOK_MAIN_TOOLBAR_HIDDEN_ITEMS_CONTEXT_MENU, '');
    }
    registerKeybindings(keybindings) {
        keybindings.registerKeybindings({
            command: NotebookCommands.CHANGE_SELECTED_CELL.id,
            keybinding: 'up',
            args: CellChangeDirection.Up,
            when: `(!editorTextFocus || ${notebook_context_keys_1.NOTEBOOK_CELL_CURSOR_FIRST_LINE}) && !suggestWidgetVisible && ${notebook_context_keys_1.NOTEBOOK_EDITOR_FOCUSED} && ${notebook_context_keys_1.NOTEBOOK_CELL_FOCUSED}`
        }, {
            command: NotebookCommands.CHANGE_SELECTED_CELL.id,
            keybinding: 'down',
            args: CellChangeDirection.Down,
            when: `(!editorTextFocus || ${notebook_context_keys_1.NOTEBOOK_CELL_CURSOR_LAST_LINE}) && !suggestWidgetVisible && ${notebook_context_keys_1.NOTEBOOK_EDITOR_FOCUSED} && ${notebook_context_keys_1.NOTEBOOK_CELL_FOCUSED}`
        }, {
            command: NotebookCommands.CUT_SELECTED_CELL.id,
            keybinding: 'ctrlcmd+x',
            when: `${notebook_context_keys_1.NOTEBOOK_EDITOR_FOCUSED} && !inputFocus && !${notebook_context_keys_1.NOTEBOOK_OUTPUT_FOCUSED}`
        }, {
            command: NotebookCommands.COPY_SELECTED_CELL.id,
            keybinding: 'ctrlcmd+c',
            when: `${notebook_context_keys_1.NOTEBOOK_EDITOR_FOCUSED} && !inputFocus && !${notebook_context_keys_1.NOTEBOOK_OUTPUT_FOCUSED}`
        }, {
            command: NotebookCommands.PASTE_CELL.id,
            keybinding: 'ctrlcmd+v',
            when: `${notebook_context_keys_1.NOTEBOOK_EDITOR_FOCUSED} && !inputFocus && !${notebook_context_keys_1.NOTEBOOK_OUTPUT_FOCUSED}`
        }, {
            command: NotebookCommands.NOTEBOOK_FIND.id,
            keybinding: 'ctrlcmd+f',
            when: `${notebook_context_keys_1.NOTEBOOK_EDITOR_FOCUSED}`
        }, {
            command: NotebookCommands.CENTER_ACTIVE_CELL.id,
            keybinding: 'ctrlcmd+l',
            when: `${notebook_context_keys_1.NOTEBOOK_EDITOR_FOCUSED}`
        });
    }
};
exports.NotebookActionsContribution = NotebookActionsContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_service_1.NotebookService),
    tslib_1.__metadata("design:type", notebook_service_1.NotebookService)
], NotebookActionsContribution.prototype, "notebookService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_kernel_quick_pick_service_1.NotebookKernelQuickPickService),
    tslib_1.__metadata("design:type", notebook_kernel_quick_pick_service_1.NotebookKernelQuickPickService)
], NotebookActionsContribution.prototype, "notebookKernelQuickPickService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_execution_service_1.NotebookExecutionService),
    tslib_1.__metadata("design:type", notebook_execution_service_1.NotebookExecutionService)
], NotebookActionsContribution.prototype, "notebookExecutionService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.ApplicationShell),
    tslib_1.__metadata("design:type", browser_1.ApplicationShell)
], NotebookActionsContribution.prototype, "shell", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_editor_widget_service_1.NotebookEditorWidgetService),
    tslib_1.__metadata("design:type", notebook_editor_widget_service_1.NotebookEditorWidgetService)
], NotebookActionsContribution.prototype, "notebookEditorWidgetService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(notebook_clipboard_service_1.NotebookClipboardService),
    tslib_1.__metadata("design:type", notebook_clipboard_service_1.NotebookClipboardService)
], NotebookActionsContribution.prototype, "notebookClipboardService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(context_key_service_1.ContextKeyService),
    tslib_1.__metadata("design:type", Object)
], NotebookActionsContribution.prototype, "contextKeyService", void 0);
exports.NotebookActionsContribution = NotebookActionsContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], NotebookActionsContribution);
var NotebookMenus;
(function (NotebookMenus) {
    NotebookMenus.NOTEBOOK_MAIN_TOOLBAR = ['notebook', 'toolbar'];
    NotebookMenus.NOTEBOOK_MAIN_TOOLBAR_CELL_ADD_GROUP = [...NotebookMenus.NOTEBOOK_MAIN_TOOLBAR, 'cell-add-group'];
    NotebookMenus.NOTEBOOK_MAIN_TOOLBAR_EXECUTION_GROUP = [...NotebookMenus.NOTEBOOK_MAIN_TOOLBAR, 'cell-execution-group'];
    NotebookMenus.NOTEBOOK_MAIN_TOOLBAR_HIDDEN_ITEMS_CONTEXT_MENU = ['notebook-main-toolbar-hidden-items-context-menu'];
})(NotebookMenus || (exports.NotebookMenus = NotebookMenus = {}));
//# sourceMappingURL=notebook-actions-contribution.js.map