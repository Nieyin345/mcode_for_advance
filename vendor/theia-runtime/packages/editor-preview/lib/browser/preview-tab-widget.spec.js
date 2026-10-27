"use strict";
// *****************************************************************************
// Copyright (C) 2026 JuliaHub, Inc. and others.
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
const chai_1 = require("chai");
const common_1 = require("@theia/core/lib/common");
const browser_1 = require("@theia/core/lib/browser");
const widgets_1 = require("@theia/core/shared/@lumino/widgets");
const preview_tab_widget_1 = require("./preview-tab-widget");
disableJSDOM();
describe('PreviewTabSupport', () => {
    before(() => {
        disableJSDOM = (0, jsdom_1.enableJSDOM)();
    });
    after(() => {
        disableJSDOM();
    });
    function createHost(overrides) {
        const widget = new widgets_1.Widget();
        const dirtyEmitter = new common_1.Emitter();
        const saveable = {
            dirty: false,
            onDirtyChanged: dirtyEmitter.event,
            onContentChanged: new common_1.Emitter().event,
            save: async () => { }
        };
        const host = {
            title: widget.title,
            saveable,
            toDispose: new common_1.DisposableCollection(),
            ...overrides
        };
        return { host, dirtyEmitter };
    }
    it('is not a preview until initialized', () => {
        const { host } = createHost();
        (0, chai_1.expect)(new preview_tab_widget_1.PreviewTabSupport(host).isPreview).false;
    });
    it('adds the italic preview title class on initialize', () => {
        const { host } = createHost();
        const trait = new preview_tab_widget_1.PreviewTabSupport(host);
        trait.initializePreview();
        (0, chai_1.expect)(trait.isPreview).true;
        (0, chai_1.expect)(host.title.className).contains(preview_tab_widget_1.PREVIEW_TITLE_CLASS);
    });
    it('promotes to a permanent tab when the content becomes dirty', () => {
        const { host, dirtyEmitter } = createHost();
        const trait = new preview_tab_widget_1.PreviewTabSupport(host);
        trait.initializePreview();
        dirtyEmitter.fire();
        (0, chai_1.expect)(trait.isPreview).false;
        (0, chai_1.expect)(host.title.className).not.contains(preview_tab_widget_1.PREVIEW_TITLE_CLASS);
    });
    it('promotes to a permanent tab when the title is pinned', () => {
        const { host } = createHost();
        const trait = new preview_tab_widget_1.PreviewTabSupport(host);
        trait.initializePreview();
        host.title.className += ` ${browser_1.PINNED_CLASS}`;
        host.title.label = 'trigger change'; // fires title.changed
        (0, chai_1.expect)(trait.isPreview).false;
    });
    it('fires onDidChangePreviewState once and is idempotent', () => {
        const { host } = createHost();
        const trait = new preview_tab_widget_1.PreviewTabSupport(host);
        trait.initializePreview();
        let count = 0;
        trait.onDidChangePreviewState(() => count++);
        trait.convertToNonPreview();
        trait.convertToNonPreview();
        (0, chai_1.expect)(count).equal(1);
        (0, chai_1.expect)(trait.isPreview).false;
    });
    it('promotes only when moved between two tab-bars', () => {
        const { host } = createHost();
        const trait = new preview_tab_widget_1.PreviewTabSupport(host);
        trait.initializePreview();
        const tabBarA = new widgets_1.TabBar();
        const tabBarB = new widgets_1.TabBar();
        trait.handleTabBarChange(undefined, tabBarA); // first attach: no promotion
        (0, chai_1.expect)(trait.isPreview).true;
        trait.handleTabBarChange(tabBarA, tabBarB); // moved: promote
        (0, chai_1.expect)(trait.isPreview).false;
    });
    it('invokes onConvertToNonPreview on promotion', () => {
        let called = false;
        const { host } = createHost({ onConvertToNonPreview: () => { called = true; } });
        const trait = new preview_tab_widget_1.PreviewTabSupport(host);
        trait.initializePreview();
        trait.convertToNonPreview();
        (0, chai_1.expect)(called).true;
    });
});
//# sourceMappingURL=preview-tab-widget.spec.js.map