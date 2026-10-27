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
exports.ScmHistoryGraphContribution = exports.ScmHistoryGraphCommands = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const command_1 = require("@theia/core/lib/common/command");
const nls_1 = require("@theia/core/lib/common/nls");
const cancellation_1 = require("@theia/core/lib/common/cancellation");
const browser_1 = require("@theia/core/lib/browser");
const quick_pick_service_1 = require("@theia/core/lib/common/quick-pick-service");
const widget_1 = require("@theia/core/lib/browser/widgets/widget");
const scm_history_graph_model_1 = require("./scm-history-graph-model");
const scm_service_1 = require("./scm-service");
const scm_context_key_service_1 = require("./scm-context-key-service");
const scm_history_graph_widget_1 = require("./scm-history-graph-widget");
const scm_history_graph_helpers_1 = require("./scm-history-graph-helpers");
var ScmHistoryGraphCommands;
(function (ScmHistoryGraphCommands) {
    ScmHistoryGraphCommands.REFRESH = command_1.Command.toDefaultLocalizedCommand({
        id: 'scmHistoryGraph.refresh',
        category: 'Source Control',
        label: 'Refresh',
        iconClass: (0, widget_1.codicon)('refresh')
    });
    ScmHistoryGraphCommands.PICK_HISTORY_ITEM_REFS = command_1.Command.toLocalizedCommand({
        id: 'scmHistoryGraph.pickHistoryItemRefs',
        category: 'Source Control',
        label: 'Pick History Item Reference...',
        iconClass: (0, widget_1.codicon)('git-branch')
    }, 'theia/scm/pickHistoryItemRefs');
    ScmHistoryGraphCommands.REVEAL_CURRENT_HISTORY_ITEM = command_1.Command.toDefaultLocalizedCommand({
        id: 'scmHistoryGraph.revealCurrentHistoryItem',
        category: 'Source Control',
        label: 'Go to Current History Item',
        iconClass: (0, widget_1.codicon)('target')
    });
    ScmHistoryGraphCommands.SET_LIST_VIEW_MODE = command_1.Command.toDefaultLocalizedCommand({
        id: 'scmHistoryGraph.setListViewMode',
        category: 'Source Control',
        label: 'View as List'
    });
    ScmHistoryGraphCommands.SET_TREE_VIEW_MODE = command_1.Command.toDefaultLocalizedCommand({
        id: 'scmHistoryGraph.setTreeViewMode',
        category: 'Source Control',
        label: 'View as Tree'
    });
})(ScmHistoryGraphCommands || (exports.ScmHistoryGraphCommands = ScmHistoryGraphCommands = {}));
/**
 * Contributes the native toolbar actions of the SCM history graph: the
 * history item reference filter picker (VS Code's "Auto" dropdown) and the
 * refresh action. Extension actions (e.g. fetch/pull/push from vscode.git)
 * are contributed separately via the `scm/history/title` menu.
 */
let ScmHistoryGraphContribution = class ScmHistoryGraphContribution {
    /**
     * The graph model, resolved lazily: instantiating it starts loading
     * history, so it must only be resolved when a graph command actually
     * runs or the graph toolbar renders (the widget has created the model
     * by then). In particular, `isEnabled`/`isVisible` are also queried by
     * the command palette and therefore consult the `ScmService` instead.
     */
    get model() {
        return this.modelProvider();
    }
    get historyProvider() {
        return this.scmService.selectedRepository?.provider.historyProvider;
    }
    registerCommands(commands) {
        commands.registerCommand(ScmHistoryGraphCommands.REFRESH, {
            isEnabled: () => !!this.historyProvider,
            isVisible: () => !!this.historyProvider,
            execute: () => this.model.refresh()
        });
        commands.registerCommand(ScmHistoryGraphCommands.PICK_HISTORY_ITEM_REFS, {
            isEnabled: () => !!this.historyProvider && !!this.quickInputService,
            isVisible: () => !!this.historyProvider,
            isToggled: () => !!this.model.historyItemRefFilter,
            execute: () => this.pickHistoryItemRefs()
        });
        commands.registerCommand(ScmHistoryGraphCommands.REVEAL_CURRENT_HISTORY_ITEM, {
            // There is nothing to reveal while the filter excludes the current ref,
            // mirroring VS Code's precondition for this action.
            isEnabled: () => !!this.historyProvider && this.scmContextKeys.scmCurrentHistoryItemRefInFilter.get() === true,
            isVisible: () => !!this.historyProvider,
            execute: () => this.model.revealCurrentHistoryItem()
        });
        commands.registerCommand(ScmHistoryGraphCommands.SET_LIST_VIEW_MODE, {
            isEnabled: () => !!this.historyProvider,
            isVisible: () => !!this.historyProvider,
            isToggled: () => this.model.viewMode === 'list',
            execute: () => this.model.setViewMode('list')
        });
        commands.registerCommand(ScmHistoryGraphCommands.SET_TREE_VIEW_MODE, {
            isEnabled: () => !!this.historyProvider,
            isVisible: () => !!this.historyProvider,
            isToggled: () => this.model.viewMode === 'tree',
            execute: () => this.model.setViewMode('tree')
        });
    }
    registerMenus(menus) {
        // Extension actions from vscode.git sit at order 900-902; the picker
        // goes before them and refresh last, matching VS Code's graph toolbar.
        menus.registerMenuAction([...scm_history_graph_widget_1.SCM_HISTORY_TITLE_MENU, 'navigation'], {
            commandId: ScmHistoryGraphCommands.PICK_HISTORY_ITEM_REFS.id,
            order: '100'
        });
        menus.registerMenuAction([...scm_history_graph_widget_1.SCM_HISTORY_TITLE_MENU, 'navigation'], {
            commandId: ScmHistoryGraphCommands.REVEAL_CURRENT_HISTORY_ITEM.id,
            order: '200'
        });
        menus.registerMenuAction([...scm_history_graph_widget_1.SCM_HISTORY_TITLE_MENU, 'navigation'], {
            commandId: ScmHistoryGraphCommands.REFRESH.id,
            order: '999'
        });
        // Groups other than 'navigation' are rendered in the toolbar's overflow menu,
        // which is where VS Code places the view mode toggles as well.
        menus.registerMenuAction([...scm_history_graph_widget_1.SCM_HISTORY_TITLE_MENU, '9_viewmode'], {
            commandId: ScmHistoryGraphCommands.SET_LIST_VIEW_MODE.id,
            order: '1'
        });
        menus.registerMenuAction([...scm_history_graph_widget_1.SCM_HISTORY_TITLE_MENU, '9_viewmode'], {
            commandId: ScmHistoryGraphCommands.SET_TREE_VIEW_MODE.id,
            order: '2'
        });
    }
    async pickHistoryItemRefs() {
        if (!this.quickInputService) {
            return;
        }
        const model = this.model;
        const provider = model.provider;
        if (!provider) {
            return;
        }
        const picker = this.quickInputService.createQuickPick();
        const cts = new cancellation_1.CancellationTokenSource();
        try {
            picker.placeholder = nls_1.nls.localize('theia/scm/pickHistoryItemRefsPlaceholder', 'Select one or more history item references');
            picker.canSelectMany = true;
            picker.matchOnDescription = true;
            // Show the picker right away and populate it once the refs arrive,
            // so that a slow ref lookup surfaces as a busy picker instead of a
            // command that appears to do nothing.
            picker.busy = true;
            const selection = await new Promise(resolve => {
                picker.onDidAccept(() => {
                    resolve(picker.selectedItems);
                    picker.hide();
                });
                // Also cancels a still-running ref lookup when the picker is dismissed.
                picker.onDidHide(() => {
                    cts.cancel();
                    resolve(undefined);
                });
                picker.show();
                provider.provideHistoryItemRefs(undefined, cts.token).then(refs => {
                    if (cts.token.isCancellationRequested) {
                        return;
                    }
                    const currentFilter = model.historyItemRefFilter;
                    const items = this.createRefPickItems(refs ?? [], provider);
                    picker.items = items;
                    picker.selectedItems = items.filter((item) => !quick_pick_service_1.QuickPickSeparator.is(item)
                        && (currentFilter ? !!item.refId && currentFilter.includes(item.refId) : item.auto === true));
                    // "Auto" is exclusive: checking it unchecks everything else and vice versa
                    let lastSelection = picker.selectedItems;
                    picker.onDidChangeSelection(newSelection => {
                        const autoNow = newSelection.some(item => item.auto);
                        if (autoNow && newSelection.length > 1) {
                            const autoBefore = lastSelection.some(item => item.auto);
                            picker.selectedItems = autoBefore ? newSelection.filter(item => !item.auto) : newSelection.filter(item => item.auto);
                        }
                        lastSelection = picker.selectedItems;
                    });
                    picker.busy = false;
                }, err => {
                    if (!cts.token.isCancellationRequested) {
                        this.logger.error('Failed to load history item refs', err);
                    }
                    picker.hide();
                });
            });
            if (!selection) {
                return;
            }
            // The selected repository may have changed while the picker was open;
            // the picked refs belong to the old provider and must not be applied
            // to the new one.
            if (model.provider !== provider) {
                return;
            }
            const refIds = selection.filter(item => item.refId !== undefined).map(item => item.refId);
            const auto = selection.some(item => item.auto) || refIds.length === 0;
            model.setHistoryItemRefFilter(auto ? undefined : refIds);
        }
        finally {
            picker.dispose();
            cts.dispose();
        }
    }
    createRefPickItems(refs, provider) {
        const autoRefs = [provider.currentHistoryItemRef, provider.currentHistoryItemRemoteRef, provider.currentHistoryItemBaseRef]
            .filter((ref) => !!ref);
        const items = [{
                label: nls_1.nls.localizeByDefault('Auto'),
                description: autoRefs.map(ref => ref.name).join(', '),
                auto: true
            }];
        const groups = [
            { label: nls_1.nls.localize('theia/scm/refPickerBranches', 'branches'), badgeClass: 'head' },
            { label: nls_1.nls.localize('theia/scm/refPickerRemoteBranches', 'remote branches'), badgeClass: 'remote' },
            { label: nls_1.nls.localize('theia/scm/refPickerTags', 'tags'), badgeClass: 'tag' }
        ];
        const grouped = new Set();
        for (const group of groups) {
            const groupRefs = refs.filter(ref => (0, scm_history_graph_helpers_1.getRefBadgeClass)(ref) === group.badgeClass);
            if (groupRefs.length > 0) {
                groupRefs.forEach(ref => grouped.add(ref));
                items.push({ type: 'separator', label: group.label });
                items.push(...groupRefs.map(ref => this.toRefPickItem(ref)));
            }
        }
        const remaining = refs.filter(ref => !grouped.has(ref));
        if (remaining.length > 0) {
            items.push({ type: 'separator' });
            items.push(...remaining.map(ref => this.toRefPickItem(ref)));
        }
        return items;
    }
    toRefPickItem(ref) {
        return {
            label: ref.name,
            description: ref.description,
            refId: ref.id
        };
    }
};
exports.ScmHistoryGraphContribution = ScmHistoryGraphContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(scm_service_1.ScmService),
    tslib_1.__metadata("design:type", scm_service_1.ScmService)
], ScmHistoryGraphContribution.prototype, "scmService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(scm_history_graph_model_1.ScmHistoryGraphModelProvider),
    tslib_1.__metadata("design:type", Function)
], ScmHistoryGraphContribution.prototype, "modelProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.QuickInputService),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], ScmHistoryGraphContribution.prototype, "quickInputService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('scm:ScmHistoryGraphContribution'),
    tslib_1.__metadata("design:type", Object)
], ScmHistoryGraphContribution.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(scm_context_key_service_1.ScmContextKeyService),
    tslib_1.__metadata("design:type", scm_context_key_service_1.ScmContextKeyService)
], ScmHistoryGraphContribution.prototype, "scmContextKeys", void 0);
exports.ScmHistoryGraphContribution = ScmHistoryGraphContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], ScmHistoryGraphContribution);
//# sourceMappingURL=scm-history-graph-contribution.js.map