"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StatusBarImpl = exports.StatusBarAlignment = exports.StatusBar = void 0;
const tslib_1 = require("tslib");
const jsx_runtime_1 = require("react/jsx-runtime");
// *****************************************************************************
// Copyright (C) 2017-2018 TypeFox and others.
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
const React = require("react");
const inversify_1 = require("inversify");
const debounce = require("lodash.debounce");
const common_1 = require("../../common");
const react_widget_1 = require("../widgets/react-widget");
const frontend_application_state_1 = require("../frontend-application-state");
const label_parser_1 = require("../label-parser");
const status_bar_types_1 = require("./status-bar-types");
Object.defineProperty(exports, "StatusBar", { enumerable: true, get: function () { return status_bar_types_1.StatusBar; } });
Object.defineProperty(exports, "StatusBarAlignment", { enumerable: true, get: function () { return status_bar_types_1.StatusBarAlignment; } });
const status_bar_view_model_1 = require("./status-bar-view-model");
const hover_service_1 = require("../hover-service");
const widgets_1 = require("../widgets");
const preferences_1 = require("../../common/preferences");
const markdown_rendering_1 = require("../../common/markdown-rendering");
let StatusBarImpl = class StatusBarImpl extends react_widget_1.ReactWidget {
    constructor(commands, entryService, applicationStateService, preferences, viewModel, hoverService) {
        super();
        this.commands = commands;
        this.entryService = entryService;
        this.applicationStateService = applicationStateService;
        this.preferences = preferences;
        this.viewModel = viewModel;
        this.hoverService = hoverService;
        this.preferencesReady = false;
        this.debouncedUpdate = debounce(() => this.update(), 50);
        delete this.scrollOptions;
        this.id = 'theia-statusBar';
        this.addClass('noselect');
        // Hide the status bar until the `workbench.statusBar.visible` preference returns with a `true` value.
        this.hide();
        this.preferences.ready.then(() => {
            this.preferencesReady = true;
            this.updateVisibility();
        });
        this.toDispose.push(this.preferences.onPreferenceChanged(preference => {
            if (preference.preferenceName === 'workbench.statusBar.visible') {
                this.updateVisibility();
            }
        }));
        this.toDispose.push(this.viewModel.onDidChange(() => this.debouncedUpdate()));
    }
    updateVisibility() {
        if (!this.preferencesReady) {
            return; // Don't change visibility until preferences have loaded
        }
        const prefHides = !this.preferences.get('workbench.statusBar.visible', true);
        this.setHidden(prefHides);
    }
    get ready() {
        return this.applicationStateService.reachedAnyState('initialized_layout', 'ready');
    }
    async setElement(id, entry) {
        await this.ready;
        this.viewModel.set(id, entry);
    }
    async removeElement(id) {
        await this.ready;
        this.viewModel.remove(id);
    }
    async setBackgroundColor(color) {
        await this.ready;
        this.internalSetBackgroundColor(color);
        this.update();
    }
    internalSetBackgroundColor(color) {
        this.backgroundColor = color;
        this.node.style.backgroundColor = this.backgroundColor || '';
    }
    async setColor(color) {
        await this.ready;
        this.internalSetColor(color);
        this.update();
    }
    internalSetColor(color) {
        this.color = color;
    }
    render() {
        const leftEntries = Array.from(this.viewModel.getLeft(), entry => this.renderElement(entry));
        const rightEntries = Array.from(this.viewModel.getRight(), entry => this.renderElement(entry));
        return (0, jsx_runtime_1.jsxs)(React.Fragment, { children: [(0, jsx_runtime_1.jsx)("div", { className: 'area left', children: leftEntries }), (0, jsx_runtime_1.jsx)("div", { className: 'area right', children: rightEntries })] });
    }
    triggerCommand(entry) {
        return () => {
            if (entry.command) {
                const args = entry.arguments || [];
                this.commands.executeCommand(entry.command, ...args);
            }
        };
    }
    /**
     * Request a hover to be displayed for a status bar entry.
     * @param e The mouse event that triggered the hover request
     * @param entry The status bar entry to display hover for
     * @param skipDelay When true, requests the hover immediately without delay (for click-triggered hovers)
     */
    requestHover(e, entry, skipDelay = false) {
        const target = e.currentTarget;
        if (typeof entry.tooltip === 'function') {
            const cancellationSource = new common_1.CancellationTokenSource();
            this.doRequestHover(target, common_1.nls.localizeByDefault('Loading...'), skipDelay, () => cancellationSource.dispose());
            Promise.resolve(entry.tooltip(cancellationSource.token))
                .catch(() => undefined)
                .then(res => res && !cancellationSource.token.isCancellationRequested && this.doRequestHover(target, res, skipDelay));
        }
        else {
            this.doRequestHover(target, entry.tooltip, skipDelay);
        }
    }
    doRequestHover(target, content, skipDelay = false, onHide) {
        this.hoverService.requestHover({
            content,
            target,
            position: 'top',
            interactive: content instanceof HTMLElement || markdown_rendering_1.MarkdownString.is(content),
            onHide,
            skipHoverDelay: skipDelay
        });
    }
    createAttributes(viewEntry) {
        const attrs = {};
        const entry = viewEntry.entry;
        attrs.id = 'status-bar-' + viewEntry.id;
        attrs.className = 'element';
        if (entry.command || entry.onclick || entry.tooltip) {
            attrs.className += ' hasCommand';
        }
        if (entry.command) {
            attrs.onClick = this.triggerCommand(entry);
        }
        else if (entry.onclick) {
            attrs.onClick = e => entry.onclick?.(e.nativeEvent);
        }
        else {
            attrs.onClick = e => this.requestHover(e, entry, true);
        }
        if (viewEntry.compact && viewEntry.alignment !== undefined) {
            attrs.className += viewEntry.alignment === status_bar_types_1.StatusBarAlignment.RIGHT ? ' compact-right' : ' compact-left';
        }
        if (entry.tooltip) {
            attrs.onMouseEnter = e => this.requestHover(e, entry);
        }
        if (entry.className) {
            attrs.className += ' ' + entry.className;
        }
        if (entry.accessibilityInformation) {
            attrs['aria-label'] = entry.accessibilityInformation.label;
            attrs.role = entry.accessibilityInformation.role;
        }
        else {
            attrs['aria-label'] = [entry.text, entry.tooltip].join(', ');
        }
        if (entry.backgroundColor) {
            attrs.className += ' has-background';
        }
        attrs.style = {
            color: entry.color || this.color,
            backgroundColor: entry.backgroundColor
        };
        return attrs;
    }
    renderElement(entry) {
        const childStrings = this.entryService.parse(entry.entry.text);
        const children = [];
        childStrings.forEach((val, key) => {
            if (label_parser_1.LabelIcon.is(val)) {
                const animation = val.animation ? ` fa-${val.animation}` : '';
                if (val.name.startsWith('codicon-')) {
                    children.push((0, jsx_runtime_1.jsx)("span", { className: `codicon ${val.name}${animation}` }, key));
                }
                else if (val.name.startsWith('fa-')) {
                    children.push((0, jsx_runtime_1.jsx)("span", { className: `fa ${val.name}${animation}` }, key));
                }
                else {
                    children.push((0, jsx_runtime_1.jsx)("span", { className: `${(0, widgets_1.codicon)(val.name)}${animation}` }, key));
                }
            }
            else {
                children.push((0, jsx_runtime_1.jsx)("span", { children: val }, key));
            }
        });
        return (0, jsx_runtime_1.jsx)("div", { ...this.createAttributes(entry), children: children }, entry.id);
    }
};
exports.StatusBarImpl = StatusBarImpl;
exports.StatusBarImpl = StatusBarImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__param(0, (0, inversify_1.inject)(common_1.CommandService)),
    tslib_1.__param(1, (0, inversify_1.inject)(label_parser_1.LabelParser)),
    tslib_1.__param(2, (0, inversify_1.inject)(frontend_application_state_1.FrontendApplicationStateService)),
    tslib_1.__param(3, (0, inversify_1.inject)(preferences_1.PreferenceService)),
    tslib_1.__param(4, (0, inversify_1.inject)(status_bar_view_model_1.StatusBarViewModel)),
    tslib_1.__param(5, (0, inversify_1.inject)(hover_service_1.HoverService)),
    tslib_1.__metadata("design:paramtypes", [Object, label_parser_1.LabelParser,
        frontend_application_state_1.FrontendApplicationStateService, Object, status_bar_view_model_1.StatusBarViewModel,
        hover_service_1.HoverService])
], StatusBarImpl);
//# sourceMappingURL=status-bar.js.map