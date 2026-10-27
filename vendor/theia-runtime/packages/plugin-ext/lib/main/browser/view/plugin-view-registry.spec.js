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
const jsdom_1 = require("@theia/core/lib/browser/test/jsdom");
// PluginViewRegistry transitively imports browser widgets (Lumino) that touch `document` at load time.
const disableJSDOM = (0, jsdom_1.enableJSDOM)();
const frontend_application_config_provider_1 = require("@theia/core/lib/browser/frontend-application-config-provider");
// Some transitively imported modules read the frontend config at load time.
frontend_application_config_provider_1.FrontendApplicationConfigProvider.set({});
const chai_1 = require("chai");
const common_1 = require("@theia/core/lib/common");
const plugin_view_registry_1 = require("./plugin-view-registry");
disableJSDOM();
/**
 * Minimal stand-in for {@link MenuModelRegistry} that records the menu actions registered for the
 * "Views" menu and removes them again when the returned disposable is disposed. This lets us assert
 * on the labels {@link PluginViewRegistry} ends up showing without wiring the full DI container.
 */
class RecordingMenuModelRegistry {
    constructor() {
        this.actions = new Map();
    }
    registerMenuAction(_menuPath, action) {
        this.actions.set(action.commandId, { ...action });
        return common_1.Disposable.create(() => this.actions.delete(action.commandId));
    }
}
describe('PluginViewRegistry - view menu labels', () => {
    let registry;
    let menus;
    const toggleCommandId = (id) => `plugin.view-container.${id}.toggle`;
    const internals = () => registry;
    function registerContainer(id, label, location) {
        internals().viewContainers.set(id, { id, location, options: { label }, onViewAdded: () => { } });
        return internals().registerViewMenuAction(id, label);
    }
    beforeEach(() => {
        registry = new plugin_view_registry_1.PluginViewRegistry();
        menus = new RecordingMenuModelRegistry();
        registry.menus = menus;
    });
    it('uses the plain label for a single container', () => {
        registerContainer('a', 'Claude Code', 'left');
        (0, chai_1.expect)(menus.actions.get(toggleCommandId('a'))?.label).to.equal('Claude Code');
    });
    it('leaves distinct labels unsuffixed', () => {
        registerContainer('a', 'Explorer', 'left');
        registerContainer('b', 'Claude Code', 'right');
        (0, chai_1.expect)(menus.actions.get(toggleCommandId('a'))?.label).to.equal('Explorer');
        (0, chai_1.expect)(menus.actions.get(toggleCommandId('b'))?.label).to.equal('Claude Code');
    });
    it('suffixes the location when two containers share a label', () => {
        registerContainer('a', 'Claude Code', 'left');
        registerContainer('b', 'Claude Code', 'right');
        (0, chai_1.expect)(menus.actions.get(toggleCommandId('a'))?.label).to.equal('Claude Code (Side Bar)');
        (0, chai_1.expect)(menus.actions.get(toggleCommandId('b'))?.label).to.equal('Claude Code (Secondary Side Bar)');
    });
    it('drops the suffix from the remaining container once the duplicate is removed', () => {
        registerContainer('a', 'Claude Code', 'left');
        const disposeB = registerContainer('b', 'Claude Code', 'right');
        disposeB.dispose();
        (0, chai_1.expect)(menus.actions.get(toggleCommandId('a'))?.label).to.equal('Claude Code');
        (0, chai_1.expect)(menus.actions.has(toggleCommandId('b'))).to.equal(false);
    });
});
describe('PluginViewRegistry - welcome-only views', () => {
    let registry;
    let createdWidget;
    let getOrCreateCalls;
    const welcome = (view) => ({ view, content: `[Hi](command:${view}.hi)`, order: 0 });
    const internals = () => registry;
    beforeEach(() => {
        registry = new plugin_view_registry_1.PluginViewRegistry();
        getOrCreateCalls = [];
        createdWidget = {
            model: {},
            handleViewWelcomeContentChange(welcomes) {
                this.welcomeArg = welcomes;
            }
        };
        registry.widgetManager = {
            getOrCreateWidget: async (factoryId, options) => {
                getOrCreateCalls.push({ factoryId, options });
                return createdWidget;
            }
        };
        internals().views.set('actions', ['container', {}]);
    });
    it('creates a welcome widget for a view with welcomes but no data provider', async () => {
        const welcomes = [welcome('actions')];
        internals().viewsWelcome.set('actions', welcomes);
        const widget = await internals().createViewDataWidget('actions');
        (0, chai_1.expect)(widget).to.equal(createdWidget);
        (0, chai_1.expect)(getOrCreateCalls).to.have.lengthOf(1);
        (0, chai_1.expect)(getOrCreateCalls[0].factoryId).to.equal(plugin_view_registry_1.PLUGIN_VIEW_DATA_FACTORY_ID);
        (0, chai_1.expect)(getOrCreateCalls[0].options).to.deep.equal({ id: 'actions' });
        (0, chai_1.expect)(createdWidget.welcomeArg).to.equal(welcomes);
        (0, chai_1.expect)(createdWidget.model.root).to.not.equal(undefined);
    });
    it('returns undefined for a view with neither a provider nor welcomes', async () => {
        const widget = await internals().createViewDataWidget('actions');
        (0, chai_1.expect)(widget).to.equal(undefined);
        (0, chai_1.expect)(getOrCreateCalls).to.have.lengthOf(0);
    });
});
//# sourceMappingURL=plugin-view-registry.spec.js.map