"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource and others.
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
let disableJSDOM = (0, jsdom_1.enableJSDOM)();
// @lumino/dragdrop (pulled in transitively via `codicon` from `@theia/core/lib/browser`) extends the
// DragEvent DOM global at module load, which JSDOM does not provide; stub it so the import succeeds.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!global.DragEvent) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    global.DragEvent = class DragEvent extends global.Event {
    };
}
const chai_1 = require("chai");
const React = require("@theia/core/shared/react");
const react_dom_1 = require("@theia/core/shared/react-dom");
const client_1 = require("@theia/core/shared/react-dom/client");
const ai_configuration_item_row_1 = require("./ai-configuration-item-row");
const ai_configuration_primitives_1 = require("./ai-configuration-primitives");
const ai_configuration_origin_badge_1 = require("./ai-configuration-origin-badge");
const ai_configuration_setting_row_1 = require("./ai-configuration-setting-row");
const ai_configuration_controls_1 = require("./ai-configuration-controls");
const browser_1 = require("@theia/core/lib/browser");
const prompt_customization_dialogs_1 = require("./prompt-customization-dialogs");
const variant_set_card_1 = require("./variant-set-card");
disableJSDOM();
/** Replaces the (single) input's text the way a keystroke does, and flushes the resulting render. */
function typeInto(container, value) {
    const input = container.querySelector('input');
    // JSDOM only accepts events built from its own window's constructor, not Node's global `Event`.
    const view = container.ownerDocument.defaultView;
    // Assigning `value` directly goes through React's patched setter, which then treats the change as
    // already handled and never calls `onChange`; the prototype's setter is what a real keystroke uses.
    const nativeSetter = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value').set;
    (0, react_dom_1.flushSync)(() => {
        nativeSetter.call(input, value);
        input.dispatchEvent(new view.Event('input', { bubbles: true }));
    });
}
/** Renders one level of an element: the output of a function component, or the children of a host element. */
function contentOf(element) {
    if (typeof element.type === 'function') {
        return element.type(element.props);
    }
    return element.props?.children;
}
/** Recursively collects the class names present anywhere in a rendered element tree. */
function classNames(node, into = []) {
    if (!node || typeof node !== 'object') {
        return into;
    }
    if (Array.isArray(node)) {
        node.forEach(child => classNames(child, into));
        return into;
    }
    const element = node;
    if (element.props?.className) {
        into.push(...element.props.className.split(/\s+/).filter(Boolean));
    }
    classNames(contentOf(element), into);
    return into;
}
/** Recursively collects the string text present anywhere in a rendered element tree. */
function textOf(node, into = []) {
    if (node === undefined || node === false) {
        return into;
    }
    if (typeof node === 'string' || typeof node === 'number') {
        into.push(String(node));
        return into;
    }
    if (Array.isArray(node)) {
        node.forEach(child => textOf(child, into));
        return into;
    }
    if (typeof node === 'object') {
        textOf(contentOf(node), into);
    }
    return into;
}
describe('AI Configuration primitives', () => {
    before(() => disableJSDOM = (0, jsdom_1.enableJSDOM)());
    after(() => disableJSDOM());
    /** Renders a component into a detached container; the caller disposes it. */
    function mount(element) {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = (0, client_1.createRoot)(container);
        (0, react_dom_1.flushSync)(() => root.render(element));
        return { container, dispose: () => { (0, react_dom_1.flushSync)(() => root.unmount()); container.remove(); } };
    }
    it('AiConfigurationCallout keeps a long message inside the box and repeats it on hover', () => {
        // A provider's failure ends up here verbatim, keys and URLs included, with nothing to wrap at.
        const message = '401 Incorrect API key provided: sk-proj-' + 'x'.repeat(120) + '. See https://platform.openai.com/account/api-keys.';
        const { container, dispose } = mount(React.createElement(ai_configuration_primitives_1.AiConfigurationCallout, {
            message,
            action: React.createElement('button', {}, 'Retry')
        }));
        try {
            const text = container.querySelector('.ai-configuration-callout-text');
            (0, chai_1.expect)(text.title).to.equal(message);
            // The action stays a sibling of the text rather than being pushed out of the row.
            (0, chai_1.expect)(container.querySelector('.ai-configuration-callout button')?.textContent).to.equal('Retry');
        }
        finally {
            dispose();
        }
    });
    it('AiEnumSelect passes a separator on as one, not as a selectable option', () => {
        // A separator that loses its flag on the way to SelectComponent becomes a selectable entry with
        // no label, and picking it commits the empty value. The field skipping it is what says it did not.
        const { container, dispose } = mount(React.createElement(ai_configuration_controls_1.AiEnumSelect, {
            value: undefined,
            options: [{ value: '', label: '', separator: true }, { value: 'a', label: 'A' }],
            ariaLabel: 'Model',
            onCommit: () => { }
        }));
        try {
            (0, chai_1.expect)(container.querySelector('.theia-select-component-label')?.textContent).to.equal('A');
        }
        finally {
            dispose();
        }
    });
    it('AiConfigurationSection renders its title and children', () => {
        const { container, dispose } = mount(React.createElement(ai_configuration_primitives_1.AiConfigurationSection, { title: 'General', children: React.createElement('span', {}, 'row') }));
        try {
            (0, chai_1.expect)(Boolean(container.querySelector('.ai-configuration-section'))).to.equal(true);
            (0, chai_1.expect)(container.textContent).to.include('General').and.to.include('row');
            // Not foldable unless asked: no chevron, and the content is not gated behind one.
            (0, chai_1.expect)(Boolean(container.querySelector('.ai-configuration-section-chevron'))).to.equal(false);
        }
        finally {
            dispose();
        }
    });
    it('AiConfigurationSection shows an entry count next to the title', () => {
        const { container, dispose } = mount(React.createElement(ai_configuration_primitives_1.AiConfigurationSection, { title: 'Skills', count: 14, children: React.createElement('span', {}, 'row') }));
        try {
            (0, chai_1.expect)(container.querySelector('.ai-configuration-section-count')?.textContent).to.equal('14');
        }
        finally {
            dispose();
        }
    });
    it('AiConfigurationSection folds its content away when collapsible, starting expanded', () => {
        const { container, dispose } = mount(React.createElement(ai_configuration_primitives_1.AiConfigurationSection, { title: 'Skills', collapsible: true, children: React.createElement('span', {}, 'row') }));
        try {
            const header = container.querySelector('.ai-configuration-section-title.foldable');
            // Browsing pages open showing their content; folding is the user's choice.
            (0, chai_1.expect)(header?.getAttribute('aria-expanded')).to.equal('true');
            (0, chai_1.expect)(container.textContent).to.include('row');
            (0, react_dom_1.flushSync)(() => header.click());
            (0, chai_1.expect)(header.getAttribute('aria-expanded')).to.equal('false');
            (0, chai_1.expect)(container.textContent).to.not.include('row');
        }
        finally {
            dispose();
        }
    });
    it('AiConfigurationSection keeps a folded section open while forced, so a filter match stays reachable', () => {
        const { container, dispose } = mount(React.createElement(ai_configuration_primitives_1.AiConfigurationSection, { title: 'Skills', collapsible: true, forceExpanded: true, children: React.createElement('span', {}, 'row') }));
        try {
            const header = container.querySelector('.ai-configuration-section-title.foldable');
            (0, react_dom_1.flushSync)(() => header.click());
            (0, chai_1.expect)(container.textContent).to.include('row');
        }
        finally {
            dispose();
        }
    });
    it('AiConfigurationItemRow exposes the label, status and an onSelect handler', () => {
        let selected = false;
        const tree = (0, ai_configuration_item_row_1.AiConfigurationItemRow)({
            label: 'Universal',
            iconClass: 'codicon-copilot',
            status: { kind: 'on', label: 'Enabled' },
            onSelect: () => { selected = true; }
        });
        (0, chai_1.expect)(textOf(tree)).to.include('Universal').and.to.include('Enabled');
        (0, chai_1.expect)(classNames(tree)).to.include('ai-configuration-status-on');
        tree.props.onClick();
        (0, chai_1.expect)(selected).to.equal(true);
    });
    it('AiConfigurationItemRow shows the modified bar and a gear that anchors its menu at the gear', () => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = (0, client_1.createRoot)(host);
        const opened = [];
        (0, react_dom_1.flushSync)(() => root.render(React.createElement(ai_configuration_item_row_1.AiConfigurationItemRow, {
            label: 'chat',
            modified: true,
            onOpenMenu: gearEl => { opened.push(gearEl); }
        })));
        const row = host.querySelector('.ai-configuration-item-row');
        (0, chai_1.expect)(row.classList.contains('modified')).to.equal(true);
        // A non-navigable row (no onSelect) shows no chevron.
        (0, chai_1.expect)(Boolean(host.querySelector('.ai-configuration-item-row-chevron'))).to.equal(false);
        const gear = host.querySelector('.ai-settings-row-gear');
        (0, chai_1.expect)(Boolean(gear)).to.equal(true);
        (0, react_dom_1.flushSync)(() => gear.click());
        (0, chai_1.expect)(opened.length).to.equal(1);
        (0, chai_1.expect)(opened[0]).to.equal(gear);
        root.unmount();
        host.remove();
    });
    /**
     * JSDOM lays nothing out, so every element reports a zero height and a description would never measure as
     * clamped. Fakes the two heights the row compares, which is exactly the browser's "the text does not fit"
     * signal, and restores them afterwards.
     */
    function withClampedText(scrollHeight, run) {
        // Both live on `Element.prototype`, which is where JSDOM defines them.
        const prototype = document.defaultView.Element.prototype;
        const original = {
            scrollHeight: Object.getOwnPropertyDescriptor(prototype, 'scrollHeight'),
            clientHeight: Object.getOwnPropertyDescriptor(prototype, 'clientHeight')
        };
        Object.defineProperty(prototype, 'scrollHeight', { configurable: true, get: () => scrollHeight });
        Object.defineProperty(prototype, 'clientHeight', { configurable: true, get: () => 40 });
        try {
            run();
        }
        finally {
            Object.defineProperty(prototype, 'scrollHeight', original.scrollHeight);
            Object.defineProperty(prototype, 'clientHeight', original.clientHeight);
        }
    }
    it('AiConfigurationItemRow expands a description that does not fit, and leaves a fitting one alone', () => {
        // A tool description running past the two-line clamp is otherwise unreadable in the list.
        withClampedText(120, () => {
            let rowOpened = 0;
            const { container, dispose } = mount(React.createElement(ai_configuration_item_row_1.AiConfigurationItemRow, {
                label: 'writeFileReplacements',
                description: 'Replace text in a file. The old text must be unique in the file.',
                onSelect: () => { rowOpened++; }
            }));
            try {
                const description = container.querySelector('.ai-configuration-item-row-description');
                (0, chai_1.expect)(description.classList.contains('expanded')).to.equal(false);
                const toggle = container.querySelector('.ai-configuration-item-row-description-toggle');
                (0, chai_1.expect)(Boolean(toggle)).to.equal(true);
                (0, chai_1.expect)(toggle.getAttribute('aria-expanded')).to.equal('false');
                (0, react_dom_1.flushSync)(() => toggle.click());
                (0, chai_1.expect)(description.classList.contains('expanded')).to.equal(true);
                (0, chai_1.expect)(container.querySelector('.ai-configuration-item-row-description-toggle').getAttribute('aria-expanded')).to.equal('true');
                // Reading the description must not also open the row's detail page.
                (0, chai_1.expect)(rowOpened).to.equal(0);
            }
            finally {
                dispose();
            }
        });
        // Nothing hidden, so no toggle to offer.
        withClampedText(40, () => {
            const { container, dispose } = mount(React.createElement(ai_configuration_item_row_1.AiConfigurationItemRow, { label: 'readFile', description: 'Read a file.' }));
            try {
                (0, chai_1.expect)(Boolean(container.querySelector('.ai-configuration-item-row-description-toggle'))).to.equal(false);
            }
            finally {
                dispose();
            }
        });
    });
    it('AiConfigurationEmptyState renders the message and an optional action', async () => {
        const tree = await (0, ai_configuration_primitives_1.AiConfigurationEmptyState)({ message: 'Nothing here', action: React.createElement('button', {}, 'Add') });
        (0, chai_1.expect)(textOf(tree)).to.include('Nothing here').and.to.include('Add');
    });
    it('AiConfigurationItemDetailHeader renders title and subtitle', async () => {
        const tree = await (0, ai_configuration_primitives_1.AiConfigurationItemDetailHeader)({ title: 'Coder', subtitle: 'agent-id-1' });
        (0, chai_1.expect)(textOf(tree)).to.include('Coder').and.to.include('agent-id-1');
    });
    it('AiConfigurationOriginBadge is a button that activates its origin, and does not open the row it sits in', () => {
        let activated = 0;
        let rowOpened = 0;
        const { container, dispose } = mount(React.createElement('div', { onClick: () => { rowOpened++; } }, React.createElement(ai_configuration_origin_badge_1.AiConfigurationOriginBadge, {
            origin: { label: 'From registry', iconClass: 'codicon-link-external', tooltip: 'Open in AI registry: x', activate: () => { activated++; } }
        })));
        try {
            const badge = container.querySelector('button.ai-configuration-origin-badge');
            (0, chai_1.expect)(badge.getAttribute('title')).to.equal('Open in AI registry: x');
            (0, chai_1.expect)(badge.textContent).to.include('From registry');
            (0, react_dom_1.flushSync)(() => badge.click());
            (0, chai_1.expect)(activated).to.equal(1);
            // The surrounding row and detail header are clickable themselves; following the badge must
            // not also open them.
            (0, chai_1.expect)(rowOpened).to.equal(0);
        }
        finally {
            dispose();
        }
    });
    it('AiConfigurationOriginBadge is not focusable when the origin leads nowhere', () => {
        const { container, dispose } = mount(React.createElement(ai_configuration_origin_badge_1.AiConfigurationOriginBadge, {
            origin: { label: 'via Acme', iconClass: 'codicon-package', tooltip: 'Acme' }
        }));
        try {
            (0, chai_1.expect)(container.querySelector('button')).to.be.null;
            (0, chai_1.expect)(container.querySelector('span.ai-configuration-origin-badge')?.textContent).to.include('via Acme');
        }
        finally {
            dispose();
        }
    });
    it('AiConfigurationOriginBadges renders one badge per origin, in order, and nothing without any', () => {
        const origin = (label) => ({ label, iconClass: 'codicon-link-external', tooltip: label, activate: () => { } });
        const { container, dispose } = mount(React.createElement(ai_configuration_origin_badge_1.AiConfigurationOriginBadges, { origins: [origin('From registry'), origin('via Acme Devtools')] }));
        try {
            (0, chai_1.expect)(Array.from(container.querySelectorAll('.ai-configuration-origin-badge')).map(badge => badge.textContent))
                .to.deep.equal(['From registry', 'via Acme Devtools']);
        }
        finally {
            dispose();
        }
        const empty = mount(React.createElement('div', {}, React.createElement(ai_configuration_origin_badge_1.AiConfigurationOriginBadges, { origins: [] })));
        try {
            (0, chai_1.expect)(empty.container.querySelector('.ai-configuration-origin-badges')).to.be.null;
        }
        finally {
            empty.dispose();
        }
    });
    it('AiConfigurationOrigin builds the same registry and Agent Plugin badges for every page to use', () => {
        const registry = ai_configuration_origin_badge_1.AiConfigurationOrigin.registry('io.github.acme/validator', () => { });
        (0, chai_1.expect)(registry.label).to.equal('From registry');
        (0, chai_1.expect)(registry.iconClass).to.contain('codicon-link-external');
        (0, chai_1.expect)(registry.tooltip).to.contain('io.github.acme/validator');
        const plugin = ai_configuration_origin_badge_1.AiConfigurationOrigin.agentPlugin({ pluginId: 'io.github.acme/devtools', name: 'Acme Devtools' }, () => { });
        (0, chai_1.expect)(plugin.label).to.equal('via Acme Devtools');
        (0, chai_1.expect)(plugin.iconClass).to.contain('codicon-package');
        (0, chai_1.expect)(plugin.tooltip).to.contain('Acme Devtools');
    });
    it('AiConfigurationSettingRow renders title and control, marks modified rows, and hides the raw id', () => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = (0, client_1.createRoot)(host);
        (0, react_dom_1.flushSync)(() => root.render(React.createElement(ai_configuration_setting_row_1.AiConfigurationSettingRow, {
            preferenceId: 'ai-features.demo',
            title: 'Demo',
            renderMarkdown: () => document.createElement('div'),
            modified: true,
            control: React.createElement('span', {}, 'ctrl')
        })));
        const row = host.querySelector('.ai-settings-row');
        (0, chai_1.expect)(row.classList.contains('modified')).to.equal(true);
        (0, chai_1.expect)(row.textContent).to.include('Demo').and.to.include('ctrl');
        // The raw preference id is no longer shown inline; it is copied through the gear menu instead.
        (0, chai_1.expect)(row.textContent).to.not.include('ai-features.demo');
        (0, react_dom_1.flushSync)(() => root.render(React.createElement(ai_configuration_setting_row_1.AiConfigurationSettingRow, {
            preferenceId: 'ai-features.demo',
            title: 'Demo',
            renderMarkdown: () => document.createElement('div'),
            modified: false
        })));
        (0, chai_1.expect)(host.querySelector('.ai-settings-row').classList.contains('modified')).to.equal(false);
        root.unmount();
        host.remove();
    });
    it('the setting-row gear delegates to the preference context menu, anchored at the gear', () => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = (0, client_1.createRoot)(host);
        const opened = [];
        (0, react_dom_1.flushSync)(() => root.render(React.createElement(ai_configuration_setting_row_1.AiConfigurationSettingRow, {
            preferenceId: 'ai-features.demo',
            title: 'Demo',
            renderMarkdown: () => document.createElement('div'),
            modified: true,
            onOpenMenu: gearEl => { opened.push(gearEl); },
            control: React.createElement('span', {}, 'ctrl')
        })));
        // The gear defers to the owner's opener (which renders the Settings UI's own preference context
        // menu via ContextMenuRenderer), passing the gear element as the anchor. No inline popover.
        const gear = host.querySelector('.ai-settings-row-gear');
        (0, chai_1.expect)(Boolean(gear)).to.equal(true);
        (0, react_dom_1.flushSync)(() => gear.click());
        (0, chai_1.expect)(opened.length).to.equal(1);
        (0, chai_1.expect)(opened[0]).to.equal(gear);
        root.unmount();
        host.remove();
    });
    it('AiConfigurationSettingRow hides the gear when no menu opener is provided', () => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = (0, client_1.createRoot)(host);
        (0, react_dom_1.flushSync)(() => root.render(React.createElement(ai_configuration_setting_row_1.AiConfigurationSettingRow, {
            preferenceId: 'ai-features.demo',
            title: 'Demo',
            renderMarkdown: () => document.createElement('div'),
            modified: true
        })));
        (0, chai_1.expect)(Boolean(host.querySelector('.ai-settings-row-gear'))).to.equal(false);
        root.unmount();
        host.remove();
    });
    it('AiConfigurationSettingRow places a full-width control in the below slot', () => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = (0, client_1.createRoot)(host);
        (0, react_dom_1.flushSync)(() => root.render(React.createElement(ai_configuration_setting_row_1.AiConfigurationSettingRow, {
            preferenceId: 'ai-features.demo',
            title: 'Demo',
            renderMarkdown: () => document.createElement('div'),
            modified: false,
            below: React.createElement('span', {}, 'wide')
        })));
        (0, chai_1.expect)(Boolean(host.querySelector('.ai-settings-row-below'))).to.equal(true);
        (0, chai_1.expect)(host.textContent).to.include('wide');
        root.unmount();
        host.remove();
    });
});
describe('PromptCustomizationDialogs', () => {
    before(() => disableJSDOM = (0, jsdom_1.enableJSDOM)());
    after(() => disableJSDOM());
    function promptServiceWith(fragments) {
        const map = new Map(Object.entries(fragments).map(([id, list]) => [id, list.map(fragment => ({ id, template: '', ...fragment }))]));
        return {
            getAllPromptFragments: () => map,
            getRawPromptFragment: (id) => map.get(id)?.[0]
        };
    }
    it('reports a built-in behind a customized fragment, so the action can reset', () => {
        const promptService = promptServiceWith({
            'coder-system-agent-mode': [{ customizationId: 'user', priority: 1 }, {}]
        });
        (0, chai_1.expect)(prompt_customization_dialogs_1.PromptCustomizationDialogs.hasBuiltIn(promptService, 'coder-system-agent-mode')).to.equal(true);
    });
    it('reports no built-in for a user-authored variant, whose reset would silently do nothing', () => {
        // A file named after the variant set becomes a custom variant of it; `PromptService.resetToBuiltIn`
        // is a no-op without a built-in, so the caller has to delete the customization instead.
        const promptService = promptServiceWith({
            'coder-system-agent-mode-nina': [{ customizationId: 'promptTemplateFolder', priority: 1 }]
        });
        (0, chai_1.expect)(prompt_customization_dialogs_1.PromptCustomizationDialogs.hasBuiltIn(promptService, 'coder-system-agent-mode-nina')).to.equal(false);
    });
    it('does not prompt for a fragment that carries no customization to remove', async () => {
        let removed = false;
        const promptService = promptServiceWith({ 'coder-system': [{}] });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        promptService.removeCustomization = () => { removed = true; };
        const result = await prompt_customization_dialogs_1.PromptCustomizationDialogs.confirmAndRemove(promptService, 'coder-system', {
            title: 'Remove',
            message: () => 'Remove?'
        });
        (0, chai_1.expect)(result).to.equal(false);
        (0, chai_1.expect)(removed).to.equal(false);
    });
    it('removes the customization the effective fragment came from, after confirmation', async () => {
        const promptService = promptServiceWith({
            'coder-system-agent-mode-nina': [{ customizationId: 'promptTemplateFolder', priority: 1 }]
        });
        const removals = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Object.assign(promptService, {
            getCustomizationType: async () => 'Prompt Templates Folder',
            getCustomizationDescription: async () => 'file:///prompts/coder-system-agent-mode-nina.prompttemplate',
            removeCustomization: async (id, customizationId) => { removals.push(`${id}/${customizationId}`); }
        });
        let shownMessage;
        // Auto-confirm the dialog: it resolves through `ConfirmDialog.open`, which needs a real accept click.
        const originalOpen = browser_1.ConfirmDialog.prototype.open;
        browser_1.ConfirmDialog.prototype.open = async function () {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            shownMessage = this.contentNode?.textContent;
            return true;
        };
        try {
            const result = await prompt_customization_dialogs_1.PromptCustomizationDialogs.confirmAndRemove(promptService, 'coder-system-agent-mode-nina', {
                title: 'Remove Prompt Template',
                message: ({ type, description }) => `${type} :: ${description}`
            });
            (0, chai_1.expect)(result).to.equal(true);
            (0, chai_1.expect)(removals).to.deep.equal(['coder-system-agent-mode-nina/promptTemplateFolder']);
            // The dialog names where the customization lives, so the user sees which file goes away.
            (0, chai_1.expect)(shownMessage).to.include('Prompt Templates Folder');
            (0, chai_1.expect)(shownMessage).to.include('coder-system-agent-mode-nina.prompttemplate');
        }
        finally {
            browser_1.ConfirmDialog.prototype.open = originalOpen;
        }
    });
});
describe('VariantSetCard', () => {
    before(() => disableJSDOM = (0, jsdom_1.enableJSDOM)());
    after(() => disableJSDOM());
    /** A set with a built-in default plus a user-authored variant, which is the one currently selected. */
    function setup() {
        const fragments = new Map([
            ['coder-system-agent-mode', [{ id: 'coder-system-agent-mode', template: '' }]],
            ['coder-system-agent-mode-nina', [{ id: 'coder-system-agent-mode-nina', template: '', customizationId: 'folder', priority: 1 }]]
        ]);
        const selections = [];
        const removals = [];
        let selected = 'coder-system-agent-mode-nina';
        const promptService = {
            getVariantIds: () => ['coder-system-agent-mode', 'coder-system-agent-mode-nina'],
            getDefaultVariantId: () => 'coder-system-agent-mode',
            getSelectedVariantId: () => selected,
            onSelectedVariantChange: () => ({ dispose: () => { } }),
            getAllPromptFragments: () => fragments,
            getRawPromptFragment: (id) => fragments.get(id)?.[0],
            getCustomizationType: async () => 'Prompt Templates Folder',
            getCustomizationDescription: async () => 'file:///prompts/coder-system-agent-mode-nina.prompttemplate',
            removeCustomization: async (id) => { removals.push(id); fragments.delete(id); },
            updateSelectedVariantId: async (agentId, _setId, variantId) => {
                selections.push([agentId, variantId]);
                selected = variantId;
            }
        };
        return { promptService, selections, removals };
    }
    function render(promptService) {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = (0, client_1.createRoot)(container);
        (0, react_dom_1.flushSync)(() => root.render(React.createElement(variant_set_card_1.VariantSetCard, {
            agentId: 'coder',
            promptVariantSetId: 'coder-system-agent-mode',
            promptService,
            settingsRowService: { openResetMenu: () => { } }
        })));
        return { container, dispose: () => { (0, react_dom_1.flushSync)(() => root.unmount()); container.remove(); } };
    }
    it('offers deletion, not a dead reset, for a selected variant that only exists as a user file', () => {
        const { promptService } = setup();
        const { container, dispose } = render(promptService);
        try {
            // `PromptService.resetToBuiltIn` is a no-op without a built-in, so the action must be a delete.
            (0, chai_1.expect)(Boolean(container.querySelector('.codicon-trash'))).to.equal(true);
            (0, chai_1.expect)(Boolean(container.querySelector('.codicon-discard'))).to.equal(false);
        }
        finally {
            dispose();
        }
    });
    it('falls back to the default variant after deleting the selected one, instead of leaving it unavailable', async () => {
        const { promptService, selections, removals } = setup();
        const { container, dispose } = render(promptService);
        const originalOpen = browser_1.ConfirmDialog.prototype.open;
        browser_1.ConfirmDialog.prototype.open = async () => true;
        try {
            const remove = container.querySelector('.ai-configuration-icon-button:last-of-type');
            remove.click();
            // Let the confirmation and both service calls settle.
            await new Promise(resolve => setTimeout(resolve, 0));
            (0, chai_1.expect)(removals).to.deep.equal(['coder-system-agent-mode-nina']);
            (0, chai_1.expect)(selections).to.deep.equal([['coder', 'coder-system-agent-mode']]);
        }
        finally {
            browser_1.ConfirmDialog.prototype.open = originalOpen;
            dispose();
        }
    });
});
describe('AiArrayInput', () => {
    before(() => disableJSDOM = (0, jsdom_1.enableJSDOM)());
    after(() => disableJSDOM());
    /** Renders the editor with a validator that refuses anything containing `*`, and reports the adds. */
    function mountList(values) {
        const added = [];
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = (0, client_1.createRoot)(container);
        (0, react_dom_1.flushSync)(() => root.render(React.createElement(ai_configuration_controls_1.AiArrayInput, {
            values,
            ariaLabel: 'Patterns',
            addPlaceholder: 'Add pattern…',
            validate: (value) => value.includes('*') ? `"${value}" is not allowed` : undefined,
            onChange: (next) => { added.push(next); }
        })));
        return { container, added, dispose: () => { (0, react_dom_1.flushSync)(() => root.unmount()); container.remove(); } };
    }
    it('adds an accepted entry', () => {
        const { container, added, dispose } = mountList(['git log ']);
        try {
            typeInto(container, 'npm test');
            (0, react_dom_1.flushSync)(() => container.querySelector('.codicon-add').click());
            (0, chai_1.expect)(added).to.deep.equal([['git log ', 'npm test']]);
        }
        finally {
            dispose();
        }
    });
    it('refuses a rejected entry, reporting why and keeping the text for correction', () => {
        const { container, added, dispose } = mountList([]);
        try {
            typeInto(container, 'git log*');
            (0, react_dom_1.flushSync)(() => container.querySelector('.codicon-add').click());
            // Nothing written, the reason is shown, and the input still holds what was typed.
            (0, chai_1.expect)(added).to.be.empty;
            (0, chai_1.expect)(container.textContent).to.include('"git log*" is not allowed');
            (0, chai_1.expect)(container.querySelector('input').value).to.equal('git log*');
        }
        finally {
            dispose();
        }
    });
    it('clears the reported problem once the text changes', () => {
        const { container, dispose } = mountList([]);
        try {
            typeInto(container, '*');
            (0, react_dom_1.flushSync)(() => container.querySelector('.codicon-add').click());
            (0, chai_1.expect)(container.textContent).to.include('not allowed');
            typeInto(container, 'npm test');
            (0, chai_1.expect)(container.textContent).to.not.include('not allowed');
        }
        finally {
            dispose();
        }
    });
});
describe('AiNumberStepper', () => {
    before(() => disableJSDOM = (0, jsdom_1.enableJSDOM)());
    after(() => disableJSDOM());
    function mountStepper(value, integer) {
        const committed = [];
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = (0, client_1.createRoot)(container);
        (0, react_dom_1.flushSync)(() => root.render(React.createElement(ai_configuration_controls_1.AiNumberStepper, {
            value,
            ariaLabel: 'Retry delay',
            integer,
            min: 0,
            onCommit: (next) => { committed.push(next); }
        })));
        return { container, committed, dispose: () => { (0, react_dom_1.flushSync)(() => root.unmount()); container.remove(); } };
    }
    /** React listens for `focusout`, not `blur`, so that is what a real focus loss delivers to it. */
    function commitByBlur(container) {
        const input = container.querySelector('input');
        const view = container.ownerDocument.defaultView;
        (0, react_dom_1.flushSync)(() => input.dispatchEvent(new view.FocusEvent('focusout', { bubbles: true })));
    }
    it('keeps a fractional value for a `number` preference', () => {
        const { container, committed, dispose } = mountStepper(60);
        try {
            typeInto(container, '1.5');
            commitByBlur(container);
            (0, chai_1.expect)(committed).to.deep.equal([1.5]);
            // Also displayed as typed: rounding it away would hide what was just stored.
            (0, chai_1.expect)(container.querySelector('input').value).to.equal('1.5');
        }
        finally {
            dispose();
        }
    });
    it('rounds a fractional value for an `integer` preference', () => {
        const { container, committed, dispose } = mountStepper(60, true);
        try {
            typeInto(container, '1.5');
            commitByBlur(container);
            (0, chai_1.expect)(committed).to.deep.equal([2]);
        }
        finally {
            dispose();
        }
    });
    it('keeps the current value when the text is not a number', () => {
        const { container, committed, dispose } = mountStepper(60);
        try {
            typeInto(container, 'soon');
            commitByBlur(container);
            (0, chai_1.expect)(committed).to.be.empty;
            (0, chai_1.expect)(container.querySelector('input').value).to.equal('60');
        }
        finally {
            dispose();
        }
    });
});
//# sourceMappingURL=ai-configuration-components.spec.js.map