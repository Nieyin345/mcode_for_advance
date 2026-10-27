"use strict";
var ScmActionButtonWidget_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScmActionButtonWidget = void 0;
const tslib_1 = require("tslib");
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
// *****************************************************************************
// Copyright (C) 2025 EclipseSource GmbH and others.
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
const core_1 = require("@theia/core");
const React = require("@theia/core/shared/react");
const browser_1 = require("@theia/core/lib/browser");
const scm_service_1 = require("./scm-service");
const label_parser_1 = require("@theia/core/lib/browser/label-parser");
const browser_menu_node_factory_1 = require("@theia/core/lib/browser/menu/browser-menu-node-factory");
let ScmActionButtonWidget = class ScmActionButtonWidget extends browser_1.ReactWidget {
    static { ScmActionButtonWidget_1 = this; }
    static { this.ID = 'scm-action-button-widget'; }
    constructor() {
        super();
        this.toDisposeOnRepositoryChange = new core_1.DisposableCollection();
        this.handleExecuteCommand = (commandId, args) => {
            this.commandService.executeCommand(commandId, ...args);
        };
        this.handleShowSecondaryMenu = (event, actionButton) => {
            event.preventDefault();
            event.stopPropagation();
            const element = event.currentTarget;
            const rect = element.getBoundingClientRect();
            // Build menu with commands that have their arguments baked in
            const menuGroups = this.buildMenuGroupsWithCommands(actionButton);
            this.contextMenuRenderer.render({
                anchor: { x: rect.left, y: rect.bottom },
                menu: {
                    children: menuGroups,
                    isEmpty: () => menuGroups.length === 0,
                    id: 'scm-action-button-dynamic-menu',
                    isVisible: () => true,
                    sortString: '0'
                },
                menuPath: ['scm-action-button-context-menu'],
                context: element,
                includeAnchorArg: false
            });
        };
        this.renderLabel = (text) => {
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
        };
        this.addClass('theia-scm-commit');
        this.id = ScmActionButtonWidget_1.ID;
    }
    ;
    onAfterAttach(msg) {
        super.onAfterAttach(msg);
        this.refreshOnRepositoryChange();
        this.toDisposeOnDetach.push(this.scmService.onDidChangeSelectedRepository(() => {
            this.refreshOnRepositoryChange();
            this.update();
        }));
    }
    ;
    refreshOnRepositoryChange() {
        this.toDisposeOnRepositoryChange.dispose();
        const repository = this.scmService.selectedRepository;
        if (repository) {
            this.toDisposeOnRepositoryChange.push(repository.provider.onDidChange(async () => {
                this.update();
            }));
            const actionButtonListener = repository.provider.onDidChangeActionButton;
            if (actionButtonListener) {
                this.toDisposeOnRepositoryChange.push(actionButtonListener(() => {
                    this.update();
                }));
            }
        }
    }
    ;
    render() {
        const repository = this.scmService.selectedRepository;
        if (repository) {
            return React.createElement('div', this.createContainerAttributes(), this.renderButton());
        }
        // eslint-disable-next-line no-null/no-null
        return null;
    }
    ;
    /**
     * Create the container attributes for the widget.
     */
    createContainerAttributes() {
        return {
            style: { flexGrow: 0 }
        };
    }
    ;
    renderButton() {
        const repo = this.scmService.selectedRepository;
        const provider = repo?.provider;
        const actionButton = provider?.actionButton;
        if (actionButton === undefined) {
            return undefined;
        }
        return (0, jsx_runtime_1.jsx)(jsx_runtime_1.Fragment, { children: (0, jsx_runtime_1.jsx)(ScmActionButtonComponent, { actionButton: actionButton, onExecuteCommand: this.handleExecuteCommand, onShowSecondaryMenu: this.handleShowSecondaryMenu, renderLabel: this.renderLabel }) });
    }
    ;
    buildMenuGroupsWithCommands(actionButton) {
        const menuGroups = [];
        actionButton.secondaryCommands?.forEach((commandGroup, groupIndex) => {
            const menuGroup = this.menuNodeFactory.createGroup(`group-${groupIndex}`);
            commandGroup.forEach((cmd, cmdIndex) => {
                // Create a custom CommandMenu node that executes the command with its arguments
                const customNode = {
                    id: `${cmd.command}-${groupIndex}-${cmdIndex}`,
                    sortString: String(cmdIndex),
                    label: this.stripIcons(cmd.title || ''),
                    icon: undefined,
                    isVisible: () => true,
                    isEnabled: () => true,
                    isToggled: () => false,
                    run: async () => {
                        await this.commandService.executeCommand(cmd.command || '', ...(cmd.arguments || []));
                    }
                };
                menuGroup.addNode(customNode);
            });
            if (menuGroup.children.length > 0) {
                menuGroups.push(menuGroup);
            }
        });
        return menuGroups;
    }
    stripIcons(text) {
        let result = '';
        const labelParts = this.labelParser.parse(text);
        labelParts.forEach(labelPart => {
            if (typeof labelPart === 'string') {
                result += labelPart;
            }
        });
        return result;
    }
    ;
};
exports.ScmActionButtonWidget = ScmActionButtonWidget;
tslib_1.__decorate([
    (0, inversify_1.inject)(scm_service_1.ScmService),
    tslib_1.__metadata("design:type", scm_service_1.ScmService)
], ScmActionButtonWidget.prototype, "scmService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.CommandService),
    tslib_1.__metadata("design:type", Object)
], ScmActionButtonWidget.prototype, "commandService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.ContextMenuRenderer),
    tslib_1.__metadata("design:type", browser_1.ContextMenuRenderer)
], ScmActionButtonWidget.prototype, "contextMenuRenderer", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(label_parser_1.LabelParser),
    tslib_1.__metadata("design:type", label_parser_1.LabelParser)
], ScmActionButtonWidget.prototype, "labelParser", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_menu_node_factory_1.BrowserMenuNodeFactory),
    tslib_1.__metadata("design:type", browser_menu_node_factory_1.BrowserMenuNodeFactory)
], ScmActionButtonWidget.prototype, "menuNodeFactory", void 0);
exports.ScmActionButtonWidget = ScmActionButtonWidget = ScmActionButtonWidget_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__metadata("design:paramtypes", [])
], ScmActionButtonWidget);
class ScmActionButtonComponent extends React.Component {
    render() {
        const { actionButton, onExecuteCommand, onShowSecondaryMenu, renderLabel } = this.props;
        const isDisabled = !actionButton.enabled;
        const result = renderLabel(actionButton.command.title || '');
        return ((0, jsx_runtime_1.jsxs)("div", { className: ScmActionButtonWidget.Styles.ACTION_BUTTON_CONTAINER, children: [(0, jsx_runtime_1.jsx)("button", { className: ScmActionButtonWidget.Styles.ACTION_BUTTON, onClick: () => onExecuteCommand(actionButton.command.command ?? '', actionButton.command.arguments || []), disabled: isDisabled, title: actionButton.command.tooltip || '', children: result }), actionButton.secondaryCommands && actionButton.secondaryCommands.length > 0 &&
                    (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("div", { className: ScmActionButtonWidget.Styles.ACTION_BUTTON_DIVIDER +
                                    (isDisabled ? ` ${ScmActionButtonWidget.Styles.ACTION_BUTTON_DIVIDER_DISABLED}` : '') }), (0, jsx_runtime_1.jsx)("button", { className: `${ScmActionButtonWidget.Styles.ACTION_BUTTON_SECONDARY} ${ScmActionButtonWidget.Styles.ACTION_BUTTON}`, onClick: e => onShowSecondaryMenu(e, actionButton), disabled: isDisabled, title: core_1.nls.localizeByDefault('More Actions...'), children: (0, jsx_runtime_1.jsx)("span", { className: (0, browser_1.codicon)('chevron-down') }) })] })] }));
    }
}
(function (ScmActionButtonComponent) {
    ;
})(ScmActionButtonComponent || (ScmActionButtonComponent = {}));
(function (ScmActionButtonWidget) {
    let Styles;
    (function (Styles) {
        Styles.ACTION_BUTTON = 'theia-scm-action-button';
        Styles.ACTION_BUTTON_SECONDARY = 'theia-scm-action-button-secondary';
        Styles.ACTION_BUTTON_DIVIDER = 'theia-scm-action-button-divider';
        Styles.ACTION_BUTTON_DIVIDER_DISABLED = 'theia-scm-action-button-divider-disabled';
        Styles.ACTION_BUTTON_CONTAINER = 'theia-scm-action-button-container';
    })(Styles = ScmActionButtonWidget.Styles || (ScmActionButtonWidget.Styles = {}));
    ;
})(ScmActionButtonWidget || (exports.ScmActionButtonWidget = ScmActionButtonWidget = {}));
//# sourceMappingURL=scm-action-button-widget.js.map