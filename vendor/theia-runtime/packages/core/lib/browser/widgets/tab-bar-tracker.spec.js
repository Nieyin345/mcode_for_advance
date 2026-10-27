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
const jsdom_1 = require("../test/jsdom");
let disableJSDOM = (0, jsdom_1.enableJSDOM)();
const chai_1 = require("chai");
const messaging_1 = require("@lumino/messaging");
const widgets_1 = require("@lumino/widgets");
const tab_bar_tracker_1 = require("./tab-bar-tracker");
disableJSDOM();
describe('TabBarTracker', () => {
    before(() => {
        disableJSDOM = (0, jsdom_1.enableJSDOM)();
    });
    after(() => {
        disableJSDOM();
    });
    let panel;
    afterEach(() => {
        if (panel) {
            widgets_1.Widget.detach(panel);
            panel.dispose();
            panel = undefined;
        }
    });
    function attachInDockPanel() {
        panel = new widgets_1.DockPanel();
        widgets_1.Widget.attach(panel, document.body);
        const widget = new widgets_1.Widget();
        panel.addWidget(widget);
        messaging_1.MessageLoop.flush();
        return widget;
    }
    it('reports the enclosing tab-bar on the first check', () => {
        const widget = attachInDockPanel();
        const events = [];
        const tracker = new tab_bar_tracker_1.TabBarTracker(widget, (oldTabBar, newTabBar) => events.push([oldTabBar, newTabBar]));
        tracker.check();
        (0, chai_1.expect)(events).lengthOf(1);
        (0, chai_1.expect)(events[0][0]).undefined;
        (0, chai_1.expect)(events[0][1]).not.undefined;
    });
    it('does not report again when the tab-bar has not changed', () => {
        const widget = attachInDockPanel();
        let count = 0;
        const tracker = new tab_bar_tracker_1.TabBarTracker(widget, () => count++);
        tracker.check();
        tracker.check();
        (0, chai_1.expect)(count).equal(1);
    });
    it('does nothing when the widget is not inside a DockPanel', () => {
        let count = 0;
        const tracker = new tab_bar_tracker_1.TabBarTracker(new widgets_1.Widget(), () => count++);
        tracker.check();
        (0, chai_1.expect)(count).equal(0);
    });
    it('stops reporting once disposed', () => {
        const widget = attachInDockPanel();
        let count = 0;
        const tracker = new tab_bar_tracker_1.TabBarTracker(widget, () => count++);
        tracker.dispose();
        tracker.check();
        (0, chai_1.expect)(count).equal(0);
    });
    it('reports a move between two tab-bars', () => {
        panel = new widgets_1.DockPanel();
        widgets_1.Widget.attach(panel, document.body);
        const other = new widgets_1.Widget();
        const widget = new widgets_1.Widget();
        panel.addWidget(other);
        panel.addWidget(widget, { mode: 'split-right', ref: other });
        messaging_1.MessageLoop.flush();
        const events = [];
        const tracker = new tab_bar_tracker_1.TabBarTracker(widget, (oldTabBar, newTabBar) => events.push([oldTabBar, newTabBar]));
        tracker.check();
        panel.addWidget(widget, { mode: 'tab-after', ref: other });
        messaging_1.MessageLoop.flush();
        tracker.check();
        (0, chai_1.expect)(events).lengthOf(2);
        (0, chai_1.expect)(events[1][0]).not.undefined;
        (0, chai_1.expect)(events[1][0]).not.equal(events[1][1]);
    });
    it('re-reports the current tab-bar after reset', () => {
        const widget = attachInDockPanel();
        const events = [];
        const tracker = new tab_bar_tracker_1.TabBarTracker(widget, (oldTabBar, newTabBar) => events.push([oldTabBar, newTabBar]));
        tracker.check();
        tracker.reset();
        tracker.check();
        (0, chai_1.expect)(events).lengthOf(2);
        (0, chai_1.expect)(events[1][0]).undefined;
        (0, chai_1.expect)(events[1][1]).not.undefined;
    });
});
//# sourceMappingURL=tab-bar-tracker.spec.js.map