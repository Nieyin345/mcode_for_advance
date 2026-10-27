"use strict";
// *****************************************************************************
// Copyright (C) 2019 TypeFox and others.
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
const jsdom_1 = require("../../test/jsdom");
let disableJSDOM = (0, jsdom_1.enableJSDOM)();
const chai_1 = require("chai");
const server_1 = require("react-dom/server");
const common_1 = require("../../../common");
const context_key_service_1 = require("../../context-key-service");
const widgets_1 = require("../../widgets");
const uri_1 = require("../../../common/uri");
const resource_context_key_1 = require("../../resource-context-key");
const tab_bar_toolbar_1 = require("./tab-bar-toolbar");
const tab_bar_toolbar_menu_adapters_1 = require("./tab-bar-toolbar-menu-adapters");
const tab_bar_toolbar_registry_1 = require("./tab-bar-toolbar-registry");
const tab_bar_toolbar_types_1 = require("./tab-bar-toolbar-types");
disableJSDOM();
describe('tab-bar-toolbar', () => {
    describe('comparator', () => {
        before(() => {
            disableJSDOM = (0, jsdom_1.enableJSDOM)();
        });
        after(() => {
            disableJSDOM();
        });
        const testMe = tab_bar_toolbar_types_1.TabBarToolbarAction.PRIORITY_COMPARATOR;
        it("should favour the 'navigation' group before everything else", () => {
            (0, chai_1.expect)(testMe({ group: 'navigation' }, { group: 'other' })).to.be.equal(-1);
        });
        it("should treat 'undefined' groups as 'navigation'", () => {
            (0, chai_1.expect)(testMe({}, {})).to.be.equal(0);
            (0, chai_1.expect)(testMe({ group: 'navigation' }, {})).to.be.equal(0);
            (0, chai_1.expect)(testMe({}, { group: 'navigation' })).to.be.equal(0);
            (0, chai_1.expect)(testMe({}, { group: 'other' })).to.be.equal(-1);
        });
        it("should fall back to 'priority' if the groups are the same", () => {
            (0, chai_1.expect)(testMe({ priority: 1 }, { priority: 2 })).to.be.equal(-1);
            (0, chai_1.expect)(testMe({ group: 'navigation', priority: 1 }, { priority: 2 })).to.be.equal(-1);
            (0, chai_1.expect)(testMe({ priority: 1 }, { group: 'navigation', priority: 2 })).to.be.equal(-1);
            (0, chai_1.expect)(testMe({ priority: 1, group: 'other' }, { priority: 2 })).to.be.equal(1);
            (0, chai_1.expect)(testMe({ group: 'other', priority: 1 }, { priority: 2, group: 'other' })).to.be.equal(-1);
            (0, chai_1.expect)(testMe({ priority: 10 }, { group: 'other', priority: 2 })).to.be.equal(-1);
            (0, chai_1.expect)(testMe({ group: 'other', priority: 10 }, { group: 'other', priority: 10 })).to.be.equal(0);
        });
    });
    describe('menu delegates', () => {
        const TEST_MENU_PATH = ['test-toolbar-delegate'];
        const TEST_COMMAND = 'test.toolbar.command';
        const TEST_SUBMENU_COMMAND = 'test.toolbar.submenu.command';
        let contextKeyService;
        before(() => {
            disableJSDOM = (0, jsdom_1.enableJSDOM)();
        });
        beforeEach(() => {
            contextKeyService = new context_key_service_1.ContextKeyServiceDummyImpl();
        });
        after(() => {
            disableJSDOM();
        });
        it('passes the delegated widget to command visibility', () => {
            const testWidget = new TestToolbarWidget();
            const commands = createCommandRegistry();
            commands.registerCommand({ id: TEST_COMMAND, label: 'Test Command' }, {
                execute: () => { },
                isVisible: widget => TestToolbarWidget.is(widget) && widget === testWidget
            });
            const menuRegistry = createMenuRegistry(commands);
            menuRegistry.registerMenuAction([...TEST_MENU_PATH, 'other'], { commandId: TEST_COMMAND });
            const registry = createToolbarRegistry(commands, menuRegistry, contextKeyService);
            registry.registerMenuDelegate(TEST_MENU_PATH, TestToolbarWidget.is);
            const commandItem = registry.visibleItems(testWidget).find(item => item.id === `${TEST_COMMAND}${tab_bar_toolbar_menu_adapters_1.TOOLBAR_WRAPPER_ID_SUFFIX}`);
            (0, chai_1.expect)(commandItem).to.exist;
            testWidget.dispose();
        });
        it('preserves the widget for wrapped command menu visibility, enablement, toggled state, and execution', async () => {
            const testWidget = new TestToolbarWidget();
            let executedWith;
            const commands = createCommandRegistry();
            commands.registerCommand({ id: TEST_COMMAND, label: 'Test Command' }, {
                execute: widget => executedWith = widget,
                isVisible: widget => TestToolbarWidget.is(widget) && widget === testWidget,
                isEnabled: widget => TestToolbarWidget.is(widget) && widget === testWidget,
                isToggled: widget => TestToolbarWidget.is(widget) && widget === testWidget
            });
            const menuRegistry = createMenuRegistry(commands);
            menuRegistry.registerMenuAction([...TEST_MENU_PATH, 'other'], { commandId: TEST_COMMAND });
            const registry = createToolbarRegistry(commands, menuRegistry, contextKeyService);
            registry.registerMenuDelegate(TEST_MENU_PATH, TestToolbarWidget.is);
            const commandItem = registry.visibleItems(testWidget).find(item => item.id === `${TEST_COMMAND}${tab_bar_toolbar_menu_adapters_1.TOOLBAR_WRAPPER_ID_SUFFIX}`);
            const node = commandItem?.toMenuNode?.();
            (0, chai_1.expect)(common_1.CommandMenu.is(node)).to.be.true;
            if (!common_1.CommandMenu.is(node)) {
                throw new Error('Expected a command menu node.');
            }
            (0, chai_1.expect)(node.isVisible(tab_bar_toolbar_types_1.TAB_BAR_TOOLBAR_CONTEXT_MENU, contextKeyService, testWidget.node, testWidget)).to.be.true;
            (0, chai_1.expect)(node.isEnabled(tab_bar_toolbar_types_1.TAB_BAR_TOOLBAR_CONTEXT_MENU, testWidget)).to.be.true;
            (0, chai_1.expect)(node.isToggled(tab_bar_toolbar_types_1.TAB_BAR_TOOLBAR_CONTEXT_MENU, testWidget)).to.be.true;
            await node.run(tab_bar_toolbar_types_1.TAB_BAR_TOOLBAR_CONTEXT_MENU, testWidget);
            (0, chai_1.expect)(executedWith).to.equal(testWidget);
            testWidget.dispose();
        });
        it('evaluates delegated items against the resource of the widget that owns the toolbar', () => {
            const testWidget = new TestToolbarWidget(new uri_1.default('probe:/a.probe'));
            const commands = createCommandRegistry();
            commands.registerCommand({ id: TEST_COMMAND, label: 'Test Command' }, { execute: () => { } });
            const menuRegistry = createMenuRegistry(commands);
            menuRegistry.registerMenuAction([...TEST_MENU_PATH, 'other'], { commandId: TEST_COMMAND, when: 'resourceScheme == probe' });
            const registry = createToolbarRegistry(commands, menuRegistry, new TestContextKeyService());
            registry.registerMenuDelegate(TEST_MENU_PATH, TestToolbarWidget.is);
            const commandItem = registry.visibleItems(testWidget).find(item => item.id === `${TEST_COMMAND}${tab_bar_toolbar_menu_adapters_1.TOOLBAR_WRAPPER_ID_SUFFIX}`);
            const otherWidget = new TestToolbarWidget(new uri_1.default('file:/a.txt'));
            (0, chai_1.expect)(commandItem).to.exist;
            (0, chai_1.expect)(registry.visibleItems(otherWidget)).to.be.empty;
            testWidget.dispose();
            otherWidget.dispose();
        });
        it('evaluates registered items against the keys contributed for the widget that owns the toolbar', () => {
            const testWidget = new TestToolbarWidget(new uri_1.default('probe:/a.probe'));
            const otherWidget = new TestToolbarWidget(new uri_1.default('probe:/b.probe'));
            const commands = createCommandRegistry();
            commands.registerCommand({ id: TEST_COMMAND, label: 'Test Command' }, { execute: () => { } });
            const menuRegistry = createMenuRegistry(commands);
            const contribution = {
                getContextKeyValues: widget => [['activeCustomEditorId', widget === testWidget ? 'test.probeEditor' : '']]
            };
            const registry = createToolbarRegistry(commands, menuRegistry, new TestContextKeyService(), [contribution]);
            registry.registerItem({ id: 'test-item', command: TEST_COMMAND, when: 'activeCustomEditorId == test.probeEditor' });
            (0, chai_1.expect)(registry.visibleItems(testWidget).map(item => item.id)).to.deep.equal(['test-item']);
            (0, chai_1.expect)(registry.visibleItems(otherWidget)).to.be.empty;
            testWidget.dispose();
            otherWidget.dispose();
        });
        it('renders the submenu chevron against the widget that owns the toolbar', () => {
            const testWidget = new TestToolbarWidget();
            const otherWidget = new TestToolbarWidget();
            const commands = createCommandRegistry();
            commands.registerCommand({ id: TEST_SUBMENU_COMMAND, label: 'Test Submenu Command' }, { execute: () => { } });
            const menuRegistry = createMenuRegistry(commands);
            menuRegistry.registerSubmenu([...TEST_MENU_PATH, 'other', 'test-submenu'], 'Test Submenu');
            menuRegistry.registerMenuAction([...TEST_MENU_PATH, 'other', 'test-submenu'], { commandId: TEST_SUBMENU_COMMAND, when: 'activeCustomEditorId == test.probeEditor' });
            const contribution = {
                getContextKeyValues: widget => [['activeCustomEditorId', widget === testWidget ? 'test.probeEditor' : '']]
            };
            const registry = createToolbarRegistry(commands, menuRegistry, new TestContextKeyService(), [contribution]);
            registry.registerMenuDelegate(TEST_MENU_PATH, TestToolbarWidget.is);
            const submenuItem = registry.visibleItems(testWidget).find(item => item.id === `test-submenu${tab_bar_toolbar_menu_adapters_1.TOOLBAR_WRAPPER_ID_SUFFIX}`);
            (0, chai_1.expect)(submenuItem).to.exist;
            (0, chai_1.expect)((0, server_1.renderToStaticMarkup)(submenuItem.render(testWidget, registry.contextMatcherFor(testWidget)))).to.contain('chevron');
            (0, chai_1.expect)((0, server_1.renderToStaticMarkup)(submenuItem.render(testWidget, registry.contextMatcherFor(otherWidget)))).to.not.contain('chevron');
            testWidget.dispose();
            otherWidget.dispose();
        });
        it('opens the More Actions menu against the widget that owns the toolbar', () => {
            const testWidget = new TestToolbarWidget();
            const otherWidget = new TestToolbarWidget();
            const commands = createCommandRegistry();
            commands.registerCommand({ id: TEST_SUBMENU_COMMAND, label: 'Test Submenu Command' }, { execute: () => { } });
            const menuRegistry = createMenuRegistry(commands);
            menuRegistry.registerSubmenu([...TEST_MENU_PATH, 'other', 'test-submenu'], 'Test Submenu');
            menuRegistry.registerMenuAction([...TEST_MENU_PATH, 'other', 'test-submenu'], { commandId: TEST_SUBMENU_COMMAND, when: 'activeCustomEditorId == test.probeEditor' });
            const contribution = {
                getContextKeyValues: widget => [['activeCustomEditorId', widget === testWidget ? 'test.probeEditor' : '']]
            };
            const ambient = new TestContextKeyService();
            const registry = createToolbarRegistry(commands, menuRegistry, ambient, [contribution]);
            registry.registerMenuDelegate(TEST_MENU_PATH, TestToolbarWidget.is);
            let rendered;
            const toolbar = new tab_bar_toolbar_1.TabBarToolbar();
            Reflect.set(toolbar, 'contextKeyService', ambient);
            Reflect.set(toolbar, 'toolbarRegistry', registry);
            Reflect.set(toolbar, 'contextMenuRenderer', {
                render: (options) => {
                    rendered = options;
                    return { dispose: () => { } };
                }
            });
            const setCurrent = Reflect.get(toolbar, 'setCurrent');
            setCurrent.call(toolbar, testWidget);
            toolbar.renderMoreContextMenu({ x: 0, y: 0 });
            (0, chai_1.expect)(rendered?.contextKeyService?.match('activeCustomEditorId == test.probeEditor')).to.be.true;
            setCurrent.call(toolbar, otherWidget);
            toolbar.renderMoreContextMenu({ x: 0, y: 0 });
            (0, chai_1.expect)(rendered?.contextKeyService?.match('activeCustomEditorId == test.probeEditor')).to.be.false;
            testWidget.dispose();
            otherWidget.dispose();
        });
        it('preserves the widget for wrapped submenu emptiness checks', () => {
            const testWidget = new TestToolbarWidget();
            const commands = createCommandRegistry();
            commands.registerCommand({ id: TEST_SUBMENU_COMMAND, label: 'Test Submenu Command' }, {
                execute: () => { },
                isVisible: widget => TestToolbarWidget.is(widget) && widget === testWidget
            });
            const menuRegistry = createMenuRegistry(commands);
            menuRegistry.registerSubmenu([...TEST_MENU_PATH, 'other', 'test-submenu'], 'Test Submenu');
            menuRegistry.registerMenuAction([...TEST_MENU_PATH, 'other', 'test-submenu'], { commandId: TEST_SUBMENU_COMMAND });
            const registry = createToolbarRegistry(commands, menuRegistry, contextKeyService);
            registry.registerMenuDelegate(TEST_MENU_PATH, TestToolbarWidget.is);
            const submenuItem = registry.visibleItems(testWidget).find(item => item.id === `test-submenu${tab_bar_toolbar_menu_adapters_1.TOOLBAR_WRAPPER_ID_SUFFIX}`);
            const node = submenuItem?.toMenuNode?.();
            (0, chai_1.expect)(common_1.CompoundMenuNode.is(node)).to.be.true;
            if (!common_1.CompoundMenuNode.is(node)) {
                throw new Error('Expected a compound menu node.');
            }
            (0, chai_1.expect)(node.isEmpty(tab_bar_toolbar_types_1.TAB_BAR_TOOLBAR_CONTEXT_MENU, contextKeyService, testWidget.node, testWidget)).to.be.false;
            testWidget.dispose();
        });
    });
});
class TestToolbarWidget extends widgets_1.Widget {
    static is(candidate) {
        return candidate instanceof TestToolbarWidget;
    }
    constructor(resourceUri) {
        super();
        this.resourceUri = resourceUri;
    }
    getResourceUri() {
        return this.resourceUri;
    }
    createMoveToUri(resourceUri) {
        return resourceUri;
    }
}
/**
 * Evaluates `key == value` clauses against the overlay alone, so that a visible item can only come from the
 * values the registry attributed to the widget.
 */
class TestContextKeyService extends context_key_service_1.ContextKeyServiceDummyImpl {
    match(expression) {
        return false;
    }
    createOverlay(overlay) {
        const values = new Map(overlay);
        return {
            match: (expression) => {
                const [key, value] = expression.split(' == ');
                return values.get(key) === value;
            }
        };
    }
}
class TestMenuNodeFactory {
    constructor(commands) {
        this.commands = commands;
    }
    createGroup(id, orderString, when) {
        return new common_1.GroupImpl(id, orderString, when);
    }
    createSubmenu(id, label, contextKeyOverlays, orderString, icon, when) {
        return new common_1.SubmenuImpl(id, label, contextKeyOverlays, orderString, icon, when);
    }
    createSubmenuLink(delegate, sortString, when) {
        return new common_1.SubMenuLink(delegate, sortString, when);
    }
    createCommandMenu(item) {
        return {
            isVisible: (_path, contextMatcher, context, ...args) => (!item.when || contextMatcher.match(item.when, context)) && this.commands.isVisible(item.commandId, ...args),
            isEnabled: (_path, ...args) => this.commands.isEnabled(item.commandId, ...args),
            isToggled: (_path, ...args) => this.commands.isToggled(item.commandId, ...args),
            id: item.commandId,
            label: item.label || this.commands.getCommand(item.commandId)?.label || '',
            icon: item.icon,
            when: item.when,
            sortString: item.order || '',
            run: async (_path, ...args) => { await this.commands.executeCommand(item.commandId, ...args); }
        };
    }
}
function createCommandRegistry() {
    return new common_1.CommandRegistry({ getContributions: () => [] });
}
function createMenuRegistry(commands) {
    return new common_1.MenuModelRegistry({ getContributions: () => [] }, commands, new TestMenuNodeFactory(commands));
}
function createToolbarRegistry(commands, menuRegistry, contextKeyService, contextKeyContributions = []) {
    const registry = new tab_bar_toolbar_registry_1.TabBarToolbarRegistry();
    Reflect.set(registry, 'commandRegistry', commands);
    Reflect.set(registry, 'contextKeyService', contextKeyService);
    Reflect.set(registry, 'menuRegistry', menuRegistry);
    Reflect.set(registry, 'keybindingRegistry', {});
    Reflect.set(registry, 'labelParser', {});
    Reflect.set(registry, 'contextMenuRenderer', { render: () => undefined });
    const resourceContextKey = new resource_context_key_1.ResourceContextKey();
    Reflect.set(resourceContextKey, 'languages', { languages: [] });
    Reflect.set(registry, 'resourceContextKey', resourceContextKey);
    Reflect.set(registry, 'contextKeyContributionProvider', { getContributions: () => contextKeyContributions });
    return registry;
}
//# sourceMappingURL=tab-bar-toolbar.spec.js.map