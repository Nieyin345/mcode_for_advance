"use strict";
// *****************************************************************************
// Copyright (C) 2019 Red Hat, Inc. and others.
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
exports.createScmTreeContainer = createScmTreeContainer;
exports.createScmWidgetContainer = createScmWidgetContainer;
require("../../src/browser/style/index.css");
const inversify_1 = require("@theia/core/shared/inversify");
const browser_1 = require("@theia/core/lib/browser");
const scm_service_1 = require("./scm-service");
const scm_contribution_1 = require("./scm-contribution");
const scm_widget_1 = require("./scm-widget");
const scm_tree_widget_1 = require("./scm-tree-widget");
const scm_commit_widget_1 = require("./scm-commit-widget");
const scm_action_button_widget_1 = require("./scm-action-button-widget");
const scm_amend_widget_1 = require("./scm-amend-widget");
const scm_tree_model_1 = require("./scm-tree-model");
const scm_groups_tree_model_1 = require("./scm-groups-tree-model");
const scm_quick_open_service_1 = require("./scm-quick-open-service");
const dirty_diff_module_1 = require("./dirty-diff/dirty-diff-module");
const scm_decorations_service_1 = require("./decorations/scm-decorations-service");
const scm_avatar_service_1 = require("./scm-avatar-service");
const scm_context_key_service_1 = require("./scm-context-key-service");
const scm_layout_migrations_1 = require("./scm-layout-migrations");
const scm_tree_label_provider_1 = require("./scm-tree-label-provider");
const tab_bar_toolbar_1 = require("@theia/core/lib/browser/shell/tab-bar-toolbar");
const color_application_contribution_1 = require("@theia/core/lib/browser/color-application-contribution");
const label_provider_1 = require("@theia/core/lib/browser/label-provider");
const scm_preferences_1 = require("../common/scm-preferences");
const merge_editor_module_1 = require("./merge-editor/merge-editor-module");
const scm_repositories_widget_1 = require("./scm-repositories-widget");
const scm_history_graph_widget_1 = require("./scm-history-graph-widget");
const scm_history_graph_model_1 = require("./scm-history-graph-model");
const scm_history_graph_contribution_1 = require("./scm-history-graph-contribution");
const core_1 = require("@theia/core");
exports.default = new inversify_1.ContainerModule(bind => {
    bind(scm_context_key_service_1.ScmContextKeyService).toSelf().inSingletonScope();
    bind(scm_service_1.ScmService).toSelf().inSingletonScope();
    bind(scm_widget_1.ScmWidget).toSelf();
    bind(browser_1.WidgetFactory).toDynamicValue(({ container }) => ({
        id: scm_contribution_1.SCM_WIDGET_FACTORY_ID,
        createWidget: () => {
            const child = createScmWidgetContainer(container);
            return child.get(scm_widget_1.ScmWidget);
        }
    })).inSingletonScope();
    bind(scm_commit_widget_1.ScmCommitWidget).toSelf();
    bind(browser_1.WidgetFactory).toDynamicValue(({ container }) => ({
        id: scm_commit_widget_1.ScmCommitWidget.ID,
        createWidget: () => container.get(scm_commit_widget_1.ScmCommitWidget)
    })).inSingletonScope();
    bind(scm_action_button_widget_1.ScmActionButtonWidget).toSelf();
    bind(browser_1.WidgetFactory).toDynamicValue(({ container }) => ({
        id: scm_action_button_widget_1.ScmActionButtonWidget.ID,
        createWidget: () => container.get(scm_action_button_widget_1.ScmActionButtonWidget)
    })).inSingletonScope();
    bind(browser_1.WidgetFactory).toDynamicValue(({ container }) => ({
        id: scm_tree_widget_1.ScmTreeWidget.ID,
        createWidget: () => container.get(scm_tree_widget_1.ScmTreeWidget)
    })).inSingletonScope();
    bind(scm_amend_widget_1.ScmAmendWidget).toSelf();
    bind(browser_1.WidgetFactory).toDynamicValue(({ container }) => ({
        id: scm_amend_widget_1.ScmAmendWidget.ID,
        createWidget: () => container.get(scm_amend_widget_1.ScmAmendWidget)
    })).inSingletonScope();
    bind(scm_repositories_widget_1.ScmRepositoriesWidget).toSelf().inSingletonScope();
    bind(browser_1.WidgetFactory).toDynamicValue(({ container }) => ({
        id: scm_repositories_widget_1.ScmRepositoriesWidget.ID,
        createWidget: () => container.get(scm_repositories_widget_1.ScmRepositoriesWidget)
    })).inSingletonScope();
    bind(scm_history_graph_model_1.ScmHistoryGraphModel).toSelf().inSingletonScope();
    bind(scm_history_graph_model_1.ScmHistoryGraphModelProvider).toFactory(ctx => () => ctx.container.get(scm_history_graph_model_1.ScmHistoryGraphModel));
    bind(scm_history_graph_contribution_1.ScmHistoryGraphContribution).toSelf().inSingletonScope();
    bind(core_1.CommandContribution).toService(scm_history_graph_contribution_1.ScmHistoryGraphContribution);
    bind(core_1.MenuContribution).toService(scm_history_graph_contribution_1.ScmHistoryGraphContribution);
    bind(scm_history_graph_widget_1.ScmHistoryGraphWidget).toSelf();
    bind(browser_1.WidgetFactory).toDynamicValue(({ container }) => ({
        id: scm_history_graph_widget_1.ScmHistoryGraphWidget.ID,
        createWidget: () => container.get(scm_history_graph_widget_1.ScmHistoryGraphWidget)
    })).inSingletonScope();
    bind(browser_1.WidgetFactory).toDynamicValue(({ container }) => ({
        id: scm_contribution_1.SCM_VIEW_CONTAINER_ID,
        createWidget: async () => {
            const viewContainer = container.get(browser_1.ViewContainer.Factory)({
                id: scm_contribution_1.SCM_VIEW_CONTAINER_ID,
                progressLocationId: 'scm'
            });
            viewContainer.setTitleOptions(scm_contribution_1.SCM_VIEW_CONTAINER_TITLE_OPTIONS);
            const widgetManager = container.get(browser_1.WidgetManager);
            const repositoriesWidget = await widgetManager.getOrCreateWidget(scm_repositories_widget_1.ScmRepositoriesWidget.ID);
            viewContainer.addWidget(repositoriesWidget, {
                order: 0,
                canHide: true,
                initiallyCollapsed: false,
                initiallyHidden: true
            });
            const scmWidget = await widgetManager.getOrCreateWidget(scm_contribution_1.SCM_WIDGET_FACTORY_ID);
            viewContainer.addWidget(scmWidget, {
                order: 1,
                canHide: false,
                initiallyCollapsed: false
            });
            const graphWidget = await widgetManager.getOrCreateWidget(scm_history_graph_widget_1.ScmHistoryGraphWidget.ID);
            viewContainer.addWidget(graphWidget, {
                order: 2,
                canHide: true,
                initiallyCollapsed: true
            });
            return viewContainer;
        }
    })).inSingletonScope();
    bind(browser_1.ApplicationShellLayoutMigration).to(scm_layout_migrations_1.ScmLayoutVersion3Migration).inSingletonScope();
    bind(browser_1.ApplicationShellLayoutMigration).to(scm_layout_migrations_1.ScmLayoutVersion5Migration).inSingletonScope();
    bind(scm_quick_open_service_1.ScmQuickOpenService).toSelf().inSingletonScope();
    (0, browser_1.bindViewContribution)(bind, scm_contribution_1.ScmContribution);
    bind(browser_1.FrontendApplicationContribution).toService(scm_contribution_1.ScmContribution);
    bind(tab_bar_toolbar_1.TabBarToolbarContribution).toService(scm_contribution_1.ScmContribution);
    bind(color_application_contribution_1.ColorContribution).toService(scm_contribution_1.ScmContribution);
    bind(browser_1.StylingParticipant).toService(scm_contribution_1.ScmContribution);
    bind(scm_decorations_service_1.ScmDecorationsService).toSelf().inSingletonScope();
    bind(scm_avatar_service_1.ScmAvatarService).toSelf().inSingletonScope();
    (0, dirty_diff_module_1.bindDirtyDiff)(bind);
    bind(scm_tree_label_provider_1.ScmTreeLabelProvider).toSelf().inSingletonScope();
    bind(label_provider_1.LabelProviderContribution).toService(scm_tree_label_provider_1.ScmTreeLabelProvider);
    (0, scm_preferences_1.bindScmPreferences)(bind);
    (0, merge_editor_module_1.bindMergeEditor)(bind);
});
function createScmTreeContainer(parent) {
    const child = (0, browser_1.createTreeContainer)(parent, {
        props: {
            virtualized: true,
            search: true,
            multiSelect: true,
        },
        widget: scm_tree_widget_1.ScmTreeWidget,
    });
    child.unbind(browser_1.TreeModel);
    child.unbind(browser_1.TreeModelImpl);
    child.bind(scm_tree_model_1.ScmTreeModelProps).toConstantValue({
        defaultExpansion: 'expanded',
    });
    return child;
}
function createScmWidgetContainer(parent) {
    const child = createScmTreeContainer(parent);
    child.bind(scm_groups_tree_model_1.ScmGroupsTreeModel).toSelf();
    child.bind(browser_1.TreeModel).toService(scm_groups_tree_model_1.ScmGroupsTreeModel);
    return child;
}
//# sourceMappingURL=scm-frontend-module.js.map