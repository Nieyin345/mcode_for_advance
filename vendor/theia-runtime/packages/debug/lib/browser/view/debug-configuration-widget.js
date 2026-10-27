"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DebugConfigurationWidget = void 0;
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
const browser_1 = require("@theia/core/lib/browser");
const common_1 = require("@theia/core/lib/common");
const inversify_1 = require("@theia/core/shared/inversify");
const React = require("@theia/core/shared/react");
const browser_2 = require("@theia/workspace/lib/browser");
const debug_console_contribution_1 = require("../console/debug-console-contribution");
const debug_configuration_manager_1 = require("../debug-configuration-manager");
const debug_commands_1 = require("../debug-commands");
const debug_session_manager_1 = require("../debug-session-manager");
const debug_action_1 = require("./debug-action");
const debug_configuration_select_1 = require("./debug-configuration-select");
const debug_view_model_1 = require("./debug-view-model");
const nls_1 = require("@theia/core/lib/common/nls");
const debug_session_options_1 = require("../debug-session-options");
const debug_session_configuration_label_provider_1 = require("../debug-session-configuration-label-provider");
let DebugConfigurationWidget = class DebugConfigurationWidget extends browser_1.ReactWidget {
    constructor() {
        super(...arguments);
        this.onRender = new common_1.DisposableCollection();
        this.setStepRef = (stepRef) => {
            this.stepRef = stepRef || undefined;
            this.onRender.dispose();
        };
        this.start = async () => {
            let configuration;
            try {
                configuration = await this.manager.getSelectedConfiguration();
            }
            catch (e) {
                this.messageService.error(e.message);
                return;
            }
            if (debug_session_options_1.DebugSessionOptions.isConfiguration(configuration)) {
                configuration.startedByUser = true;
            }
            this.commandRegistry.executeCommand(debug_commands_1.DebugCommands.START.id, configuration);
        };
        this.openConfiguration = () => this.manager.openConfiguration();
        this.openConsole = () => this.debugConsole.openView({
            activate: true
        });
    }
    init() {
        this.addClass('debug-toolbar');
        this.toDispose.push(this.manager.onDidChange(() => this.update()));
        this.toDispose.push(this.workspaceService.onWorkspaceChanged(() => this.update()));
        this.toDispose.push(this.workspaceService.onWorkspaceLocationChanged(() => this.update()));
        this.scrollOptions = undefined;
        this.update();
    }
    focus() {
        if (!this.doFocus()) {
            this.onRender.push(common_1.Disposable.create(() => this.doFocus()));
            this.update();
        }
    }
    doFocus() {
        if (!this.stepRef) {
            return false;
        }
        this.stepRef.focus();
        return true;
    }
    render() {
        return (0, jsx_runtime_1.jsxs)(React.Fragment, { children: [(0, jsx_runtime_1.jsx)(debug_action_1.DebugAction, { run: this.start, label: nls_1.nls.localizeByDefault('Start Debugging'), iconClass: 'debug-start', ref: this.setStepRef }), (0, jsx_runtime_1.jsx)(debug_configuration_select_1.DebugConfigurationSelect, { manager: this.manager, quickInputService: this.quickInputService, isMultiRoot: this.workspaceService.isMultiRootWorkspaceOpened, labelProvider: this.sessionConfigurationLabelProvider }), (0, jsx_runtime_1.jsx)(debug_action_1.DebugAction, { run: this.openConfiguration, label: nls_1.nls.localizeByDefault('Open {0}', '"launch.json"'), iconClass: 'settings-gear' }), (0, jsx_runtime_1.jsx)(debug_action_1.DebugAction, { run: this.openConsole, label: nls_1.nls.localizeByDefault('Debug Console'), iconClass: 'terminal' })] });
    }
};
exports.DebugConfigurationWidget = DebugConfigurationWidget;
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.CommandRegistry),
    tslib_1.__metadata("design:type", common_1.CommandRegistry)
], DebugConfigurationWidget.prototype, "commandRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_view_model_1.DebugViewModel),
    tslib_1.__metadata("design:type", debug_view_model_1.DebugViewModel)
], DebugConfigurationWidget.prototype, "viewModel", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_configuration_manager_1.DebugConfigurationManager),
    tslib_1.__metadata("design:type", debug_configuration_manager_1.DebugConfigurationManager)
], DebugConfigurationWidget.prototype, "manager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_session_manager_1.DebugSessionManager),
    tslib_1.__metadata("design:type", debug_session_manager_1.DebugSessionManager)
], DebugConfigurationWidget.prototype, "sessionManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_console_contribution_1.DebugConsoleContribution),
    tslib_1.__metadata("design:type", debug_console_contribution_1.DebugConsoleContribution)
], DebugConfigurationWidget.prototype, "debugConsole", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.QuickInputService),
    tslib_1.__metadata("design:type", Object)
], DebugConfigurationWidget.prototype, "quickInputService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_2.WorkspaceService),
    tslib_1.__metadata("design:type", browser_2.WorkspaceService)
], DebugConfigurationWidget.prototype, "workspaceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.MessageService),
    tslib_1.__metadata("design:type", common_1.MessageService)
], DebugConfigurationWidget.prototype, "messageService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_session_configuration_label_provider_1.DebugSessionConfigurationLabelProvider),
    tslib_1.__metadata("design:type", debug_session_configuration_label_provider_1.DebugSessionConfigurationLabelProvider)
], DebugConfigurationWidget.prototype, "sessionConfigurationLabelProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], DebugConfigurationWidget.prototype, "init", null);
exports.DebugConfigurationWidget = DebugConfigurationWidget = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], DebugConfigurationWidget);
//# sourceMappingURL=debug-configuration-widget.js.map