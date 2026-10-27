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
const frontend_application_config_provider_1 = require("@theia/core/lib/browser/frontend-application-config-provider");
frontend_application_config_provider_1.FrontendApplicationConfigProvider.set({});
const chai_1 = require("chai");
const react_dom_1 = require("@theia/core/shared/react-dom");
const client_1 = require("@theia/core/shared/react-dom/client");
const collection_category_renderer_1 = require("./collection-category-renderer");
disableJSDOM();
describe('CollectionCategoryRenderer', () => {
    before(() => disableJSDOM = (0, jsdom_1.enableJSDOM)());
    after(() => disableJSDOM());
    class TestCollection extends collection_category_renderer_1.CollectionCategoryRenderer {
        constructor(items) {
            super();
            this.items = items;
        }
        get categoryId() {
            return 'agents';
        }
        getTreeChildren() {
            return this.items;
        }
        renderItemSections() {
            return undefined;
        }
        getEmptyMessage() {
            return 'No agents';
        }
    }
    function renderOverview(items) {
        // React reports duplicate keys through console.error; capture it so the test can assert on it, and
        // capture console.warn too so the renderer's expected duplicate-id warning stays out of the output.
        const warnings = [];
        const originalError = console.error;
        const originalWarn = console.warn;
        console.error = (...args) => { warnings.push(String(args[0])); };
        console.warn = (...args) => { warnings.push(String(args[0])); };
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = (0, client_1.createRoot)(container);
        const ctx = { scope: 'user', navigate: () => { }, update: () => { } };
        try {
            (0, react_dom_1.flushSync)(() => root.render(new TestCollection(items).renderOverview(ctx)));
        }
        finally {
            console.error = originalError;
            console.warn = originalWarn;
        }
        return { container, warnings, dispose: () => { (0, react_dom_1.flushSync)(() => root.unmount()); container.remove(); } };
    }
    it('shows one row per id, dropping an entry that repeats one', () => {
        const { container, warnings, dispose } = renderOverview([
            { id: 'code-reviewer', label: 'Code Reviewer' },
            { id: 'code-reviewer', label: 'Code Reviewer (copy)' },
            { id: 'coder', label: 'Coder' }
        ]);
        try {
            const labels = Array.from(container.querySelectorAll('.ai-configuration-item-row-label')).map(label => label.textContent);
            // The first wins: a repeated id is not addressable, so showing it would be a row that opens another.
            (0, chai_1.expect)(labels).to.deep.equal(['Code Reviewer', 'Coder']);
            // And no React duplicate-key warnings, which is what a rendered duplicate produced.
            (0, chai_1.expect)(warnings.filter(warning => warning.includes('same key'))).to.be.empty;
        }
        finally {
            dispose();
        }
    });
    it('logs the dropped id once, however often the overview re-renders', () => {
        const items = [
            { id: 'code-reviewer', label: 'Code Reviewer' },
            { id: 'code-reviewer', label: 'Code Reviewer (copy)' }
        ];
        const collection = new TestCollection(items);
        const ctx = { scope: 'user', navigate: () => { }, update: () => { } };
        const logged = [];
        const originalWarn = console.warn;
        console.warn = (...args) => { logged.push(String(args[0])); };
        try {
            collection.renderOverview(ctx);
            collection.renderOverview(ctx);
        }
        finally {
            console.warn = originalWarn;
        }
        (0, chai_1.expect)(logged).to.have.lengthOf(1);
        (0, chai_1.expect)(logged[0]).to.include('code-reviewer').and.to.include('agents');
    });
    it('leaves items with unique ids untouched, reporting their own status', () => {
        const { container, dispose } = renderOverview([
            { id: 'coder', label: 'Coder', status: { kind: 'on', label: 'Enabled' } },
            { id: 'architect', label: 'Architect', status: { kind: 'off', label: 'Disabled' } }
        ]);
        try {
            const badges = Array.from(container.querySelectorAll('.ai-configuration-status-badge-label')).map(badge => badge.textContent);
            (0, chai_1.expect)(badges).to.deep.equal(['Enabled', 'Disabled']);
        }
        finally {
            dispose();
        }
    });
});
//# sourceMappingURL=collection-category-renderer.spec.js.map