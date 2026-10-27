"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProblemContribution = exports.ProblemsCommands = exports.ProblemsMenu = exports.PROBLEMS_CONTEXT_MENU = void 0;
const tslib_1 = require("tslib");
const debounce = require("@theia/core/shared/lodash.debounce");
const inversify_1 = require("@theia/core/shared/inversify");
const browser_1 = require("@theia/core/lib/browser");
const message_service_1 = require("@theia/core/lib/common/message-service");
const status_bar_1 = require("@theia/core/lib/browser/status-bar/status-bar");
const view_contribution_1 = require("@theia/core/lib/browser/shell/view-contribution");
const problem_marker_1 = require("../../common/problem-marker");
const problem_manager_1 = require("./problem-manager");
const problem_widget_1 = require("./problem-widget");
const marker_tree_1 = require("../marker-tree");
const command_1 = require("@theia/core/lib/common/command");
const context_key_service_1 = require("@theia/core/lib/browser/context-key-service");
const nls_1 = require("@theia/core/lib/common/nls");
const browser_2 = require("@theia/filesystem/lib/browser");
const file_service_1 = require("@theia/filesystem/lib/browser/file-service");
exports.PROBLEMS_CONTEXT_MENU = [problem_marker_1.PROBLEM_KIND];
var ProblemsMenu;
(function (ProblemsMenu) {
    ProblemsMenu.CLIPBOARD = [...exports.PROBLEMS_CONTEXT_MENU, '1_clipboard'];
    ProblemsMenu.PROBLEMS = [...exports.PROBLEMS_CONTEXT_MENU, '2_problems'];
})(ProblemsMenu || (exports.ProblemsMenu = ProblemsMenu = {}));
var ProblemsCommands;
(function (ProblemsCommands) {
    ProblemsCommands.COLLAPSE_ALL = {
        id: 'problems.collapse.all'
    };
    ProblemsCommands.COLLAPSE_ALL_TOOLBAR = {
        id: 'problems.collapse.all.toolbar',
        iconClass: (0, browser_1.codicon)('collapse-all')
    };
    ProblemsCommands.COPY = command_1.Command.toDefaultLocalizedCommand({
        id: 'problems.copy',
        category: 'Problems',
        label: 'Copy'
    });
    ProblemsCommands.COPY_MESSAGE = command_1.Command.toDefaultLocalizedCommand({
        id: 'problems.copy.message',
        category: 'Problems',
        label: 'Copy Message'
    });
    ProblemsCommands.COPY_AS_TEXT = command_1.Command.toLocalizedCommand({
        id: 'problems.copy.as.text',
        category: 'Problems',
        label: 'Copy as Text'
    }, 'theia/markers/copyAsText', nls_1.nls.getDefaultKey('Problems'));
    ProblemsCommands.SELECT_ALL = command_1.Command.toDefaultLocalizedCommand({
        id: 'problems.select.all',
        category: 'Problems',
        label: 'Select All'
    });
    ProblemsCommands.EXPORT = command_1.Command.toLocalizedCommand({
        id: 'problems.export',
        category: 'Problems',
        label: 'Export',
        iconClass: (0, browser_1.codicon)('arrow-circle-up')
    }, 'theia/markers/export', nls_1.nls.getDefaultKey('Problems'));
    ProblemsCommands.CLEAR_ALL = command_1.Command.toLocalizedCommand({
        id: 'problems.clear.all',
        category: 'Problems',
        label: 'Clear All',
        iconClass: (0, browser_1.codicon)('clear-all')
    }, 'theia/markers/clearAll', nls_1.nls.getDefaultKey('Problems'));
})(ProblemsCommands || (exports.ProblemsCommands = ProblemsCommands = {}));
let ProblemContribution = class ProblemContribution extends view_contribution_1.AbstractViewContribution {
    constructor() {
        super({
            widgetId: problem_widget_1.PROBLEMS_WIDGET_ID,
            widgetName: nls_1.nls.localizeByDefault('Problems'),
            defaultWidgetOptions: {
                area: 'bottom'
            },
            toggleCommandId: 'problemsView:toggle',
            toggleKeybinding: 'ctrlcmd+shift+m'
        });
        this.updateStatusBarElement = debounce(() => this.setStatusBarElement(this.problemManager.getProblemStat()), 10);
    }
    onStart(app) {
        this.updateStatusBarElement();
        this.problemManager.onDidChangeMarkers(this.updateStatusBarElement);
        const problemsFocusKey = this.contextKeyService.createKey('problemsFocus', false);
        const updateFocusKey = () => {
            problemsFocusKey.set(this.shell.activeWidget instanceof problem_widget_1.ProblemWidget);
        };
        updateFocusKey();
        this.shell.onDidChangeActiveWidget(updateFocusKey);
    }
    async initializeLayout(app) {
        await this.openView();
    }
    setStatusBarElement(problemStat) {
        this.statusBar.setElement('problem-marker-status', {
            text: problemStat.infos <= 0
                ? `$(codicon-error) ${problemStat.errors} $(codicon-warning) ${problemStat.warnings}`
                : `$(codicon-error) ${problemStat.errors} $(codicon-warning) ${problemStat.warnings} $(codicon-info) ${problemStat.infos}`,
            alignment: status_bar_1.StatusBarAlignment.LEFT,
            priority: 10,
            command: this.toggleCommand ? this.toggleCommand.id : undefined,
            tooltip: this.getStatusBarTooltip(problemStat)
        });
    }
    /**
     * Get the tooltip to be displayed when hovering over the problem statusbar item.
     * - Displays `No Problems` when no problems are present.
     * - Displays a human-readable label which describes for each type of problem stat properties,
     * their overall count and type when any one of these properties has a positive count.
     * @param stat the problem stat describing the number of `errors`, `warnings` and `infos`.
     *
     * @return the tooltip to be displayed in the statusbar.
     */
    getStatusBarTooltip(stat) {
        if (stat.errors <= 0 && stat.warnings <= 0 && stat.infos <= 0) {
            return nls_1.nls.localizeByDefault('No Problems');
        }
        const tooltip = [];
        if (stat.errors > 0) {
            tooltip.push(nls_1.nls.localizeByDefault('{0} Errors', stat.errors));
        }
        if (stat.warnings > 0) {
            tooltip.push(nls_1.nls.localizeByDefault('{0} Warnings', stat.warnings));
        }
        if (stat.infos > 0) {
            tooltip.push(nls_1.nls.localizeByDefault('{0} Infos', stat.infos));
        }
        return tooltip.join(', ');
    }
    registerCommands(commands) {
        super.registerCommands(commands);
        commands.registerCommand(ProblemsCommands.COLLAPSE_ALL, {
            execute: () => this.collapseAllProblems()
        });
        commands.registerCommand(ProblemsCommands.COLLAPSE_ALL_TOOLBAR, {
            isEnabled: widget => this.withWidget(widget, () => true),
            isVisible: widget => this.withWidget(widget, () => true),
            execute: widget => this.withWidget(widget, () => this.collapseAllProblems())
        });
        commands.registerCommand(ProblemsCommands.COPY, {
            isEnabled: () => this.withWidget(undefined, () => true),
            isVisible: () => this.withWidget(undefined, widget => this.getSelectedMarkerNodes(widget).length > 0),
            execute: () => this.withWidget(undefined, widget => {
                const selections = this.getSelectedMarkerNodes(widget)
                    .map(node => ({ marker: node.marker }));
                if (selections.length > 0) {
                    this.copy(selections);
                }
            })
        });
        commands.registerCommand(ProblemsCommands.COPY_MESSAGE, {
            isEnabled: () => this.withWidget(undefined, () => true),
            isVisible: () => this.withWidget(undefined, widget => this.getSelectedMarkerNodes(widget).length > 0),
            execute: () => this.withWidget(undefined, widget => {
                const selections = this.getSelectedMarkerNodes(widget)
                    .map(node => ({ marker: node.marker }));
                if (selections.length > 0) {
                    this.copyMessage(selections);
                }
            })
        });
        commands.registerCommand(ProblemsCommands.COPY_AS_TEXT, {
            isEnabled: () => this.withWidget(undefined, () => true),
            isVisible: () => this.withWidget(undefined, () => true),
            execute: () => this.withWidget(undefined, widget => {
                const selectedSet = new Set(widget.model.selectedNodes);
                if (selectedSet.size > 0) {
                    this.copyAsText(widget, widget.model.root, selectedSet);
                }
            })
        });
        commands.registerCommand(ProblemsCommands.SELECT_ALL, {
            isEnabled: () => this.withWidget(undefined, () => true),
            isVisible: () => this.withWidget(undefined, () => true),
            execute: () => this.withWidget(undefined, widget => this.selectAllProblems(widget))
        });
        commands.registerCommand(ProblemsCommands.EXPORT, {
            isEnabled: () => this.withWidget(undefined, () => true),
            isVisible: () => this.withWidget(undefined, () => true),
            execute: async () => {
                await this.withWidget(undefined, async (widget) => await this.exportProblems(widget));
            }
        });
        commands.registerCommand(ProblemsCommands.CLEAR_ALL, {
            isEnabled: widget => this.withWidget(widget, () => true),
            isVisible: widget => this.withWidget(widget, () => true),
            execute: widget => this.withWidget(widget, () => this.problemManager.cleanAllMarkers())
        });
    }
    registerMenus(menus) {
        super.registerMenus(menus);
        menus.registerMenuAction(ProblemsMenu.CLIPBOARD, {
            commandId: ProblemsCommands.COPY.id,
            label: nls_1.nls.localizeByDefault('Copy'),
            order: '0'
        });
        menus.registerMenuAction(ProblemsMenu.CLIPBOARD, {
            commandId: ProblemsCommands.COPY_MESSAGE.id,
            label: nls_1.nls.localizeByDefault('Copy Message'),
            order: '1'
        });
        menus.registerMenuAction(ProblemsMenu.CLIPBOARD, {
            commandId: ProblemsCommands.COPY_AS_TEXT.id,
            order: '2'
        });
        menus.registerMenuAction(ProblemsMenu.CLIPBOARD, {
            commandId: ProblemsCommands.EXPORT.id,
            order: '3'
        });
        menus.registerMenuAction(ProblemsMenu.PROBLEMS, {
            commandId: ProblemsCommands.COLLAPSE_ALL.id,
            label: nls_1.nls.localizeByDefault('Collapse All'),
            order: '2'
        });
        menus.registerMenuAction(ProblemsMenu.PROBLEMS, {
            commandId: ProblemsCommands.SELECT_ALL.id,
            label: nls_1.nls.localizeByDefault('Select All'),
            order: '3'
        });
    }
    async registerToolbarItems(toolbarRegistry) {
        toolbarRegistry.registerItem({
            id: ProblemsCommands.COLLAPSE_ALL_TOOLBAR.id,
            command: ProblemsCommands.COLLAPSE_ALL_TOOLBAR.id,
            tooltip: nls_1.nls.localizeByDefault('Collapse All'),
            priority: 0,
        });
        toolbarRegistry.registerItem({
            id: ProblemsCommands.CLEAR_ALL.id,
            command: ProblemsCommands.CLEAR_ALL.id,
            tooltip: ProblemsCommands.CLEAR_ALL.label,
            priority: 1,
        });
    }
    registerKeybindings(keybindings) {
        keybindings.registerKeybinding({
            command: ProblemsCommands.COPY_AS_TEXT.id,
            keybinding: 'ctrlcmd+c',
            when: 'problemsFocus'
        });
        keybindings.registerKeybinding({
            command: ProblemsCommands.SELECT_ALL.id,
            keybinding: 'ctrlcmd+a',
            when: 'problemsFocus'
        });
    }
    async collapseAllProblems() {
        const { model } = await this.widget;
        const root = model.root;
        const firstChild = root.children[0];
        root.children.forEach(child => browser_1.CompositeTreeNode.is(child) && model.collapseAll(child));
        if (browser_1.SelectableTreeNode.is(firstChild)) {
            model.selectNode(firstChild);
        }
    }
    selectAllProblems(widget) {
        const { model } = widget;
        const root = model.root;
        if (root) {
            model.clearSelection();
            this.selectAllNodes(root, model);
        }
    }
    selectAllNodes(node, model) {
        if (browser_1.SelectableTreeNode.is(node)) {
            model.addSelection({ node, type: browser_1.TreeSelection.SelectionType.TOGGLE });
        }
        if (browser_1.CompositeTreeNode.is(node) && node.children) {
            for (const child of node.children) {
                this.selectAllNodes(child, model);
            }
        }
    }
    getSelectedMarkerNodes(widget) {
        return widget.model.selectedNodes.filter(marker_tree_1.MarkerNode.is);
    }
    addToClipboard(content) {
        const handleCopy = (e) => {
            document.removeEventListener('copy', handleCopy);
            if (e.clipboardData) {
                e.clipboardData.setData('text/plain', content);
                e.preventDefault();
            }
        };
        document.addEventListener('copy', handleCopy);
        document.execCommand('copy');
    }
    copy(selections) {
        const selectionsArray = Array.isArray(selections) ? selections : [selections];
        const serializedProblems = selectionsArray.map(selection => this.serializeMarker(selection.marker));
        this.addToClipboard(JSON.stringify(serializedProblems, undefined, '\t'));
    }
    copyMessage(selections) {
        const selectionsArray = Array.isArray(selections) ? selections : [selections];
        const messages = selectionsArray.map(selection => {
            const marker = selection.marker;
            return marker.data.message;
        });
        this.addToClipboard(messages.join('\n'));
    }
    serializeMarker(marker) {
        return {
            resource: marker.uri,
            owner: marker.owner,
            code: marker.data.code,
            severity: marker.data.severity,
            message: marker.data.message,
            source: marker.data.source,
            startLineNumber: marker.data.range.start.line,
            startColumn: marker.data.range.start.character,
            endLineNumber: marker.data.range.end.line,
            endColumn: marker.data.range.end.character
        };
    }
    copyAsText(widget, root, selectedSet) {
        const lines = [];
        if (root) {
            this.collectSelectedLinesInOrder(widget, root, selectedSet, lines);
        }
        this.addToClipboard(lines.join('\n'));
    }
    collectSelectedLinesInOrder(widget, node, selectedSet, lines) {
        if (selectedSet.has(node)) {
            if (marker_tree_1.MarkerInfoNode.is(node)) {
                lines.push(widget.formatMarkerFileNodeAsText(node));
            }
            else if (marker_tree_1.MarkerNode.is(node)) {
                lines.push(widget.formatMarkerNodeAsText(node));
            }
        }
        if (browser_1.CompositeTreeNode.is(node) && node.children) {
            for (const child of node.children) {
                this.collectSelectedLinesInOrder(widget, child, selectedSet, lines);
            }
        }
    }
    async exportProblems(widget) {
        const selectedNodes = widget.model.selectedNodes;
        if (selectedNodes.length === 0) {
            return;
        }
        const markerNodes = this.collectMarkerNodes(selectedNodes, new Set());
        if (markerNodes.length === 0) {
            return;
        }
        const filePath = await this.fileDialogService.showSaveDialog({
            title: nls_1.nls.localize('theia/markers/exportProblems', 'Export Problems'),
            filters: { [nls_1.nls.localize('theia/markers/jsonFiles', 'JSON Files')]: ['json'] },
            saveLabel: nls_1.nls.localizeByDefault('Export'),
            inputValue: nls_1.nls.localizeByDefault('Problems').toLowerCase() + '.json'
        });
        if (!filePath) {
            return;
        }
        try {
            const serializedProblems = markerNodes.map(node => this.serializeMarker(node.marker));
            const content = JSON.stringify(serializedProblems, undefined, '\t');
            await this.fileService.write(filePath, content);
            this.messageService.info(nls_1.nls.localize('theia/markers/exportSuccess', 'Problems exported successfully.'));
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.messageService.error(errorMessage);
        }
    }
    collectMarkerNodes(nodes, seen) {
        for (const node of nodes) {
            if (marker_tree_1.MarkerNode.is(node)) {
                seen.add(node);
            }
            else if (browser_1.CompositeTreeNode.is(node)) {
                this.collectMarkerNodes(node.children, seen);
            }
        }
        return Array.from(seen);
    }
    withWidget(widget = this.tryGetWidget(), cb) {
        if (widget instanceof problem_widget_1.ProblemWidget && widget.id === problem_widget_1.PROBLEMS_WIDGET_ID) {
            return cb(widget);
        }
        return false;
    }
};
exports.ProblemContribution = ProblemContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(problem_manager_1.ProblemManager),
    tslib_1.__metadata("design:type", problem_manager_1.ProblemManager)
], ProblemContribution.prototype, "problemManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(status_bar_1.StatusBar),
    tslib_1.__metadata("design:type", Object)
], ProblemContribution.prototype, "statusBar", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_2.FileDialogService),
    tslib_1.__metadata("design:type", Object)
], ProblemContribution.prototype, "fileDialogService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(file_service_1.FileService),
    tslib_1.__metadata("design:type", file_service_1.FileService)
], ProblemContribution.prototype, "fileService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(context_key_service_1.ContextKeyService),
    tslib_1.__metadata("design:type", Object)
], ProblemContribution.prototype, "contextKeyService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(message_service_1.MessageService),
    tslib_1.__metadata("design:type", message_service_1.MessageService)
], ProblemContribution.prototype, "messageService", void 0);
exports.ProblemContribution = ProblemContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__metadata("design:paramtypes", [])
], ProblemContribution);
//# sourceMappingURL=problem-contribution.js.map