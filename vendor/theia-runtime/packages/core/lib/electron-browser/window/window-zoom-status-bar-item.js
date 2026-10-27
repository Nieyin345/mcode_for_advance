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
var WindowZoomStatusBarItem_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.WindowZoomStatusBarItem = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("inversify");
const browser_1 = require("../../browser");
const common_1 = require("../../common");
const electron_window_preferences_1 = require("../../electron-common/electron-window-preferences");
const window_zoom_action_bar_1 = require("./window-zoom-action-bar");
let WindowZoomStatusBarItem = class WindowZoomStatusBarItem {
    static { WindowZoomStatusBarItem_1 = this; }
    static { this.ID = 'window-zoom-status'; }
    onStart() {
        this.preferenceService.ready.then(() => {
            this.updateZoomStatusBarItem();
            this.preferenceService.onPreferenceChanged(e => {
                if (e.preferenceName === electron_window_preferences_1.PREF_WINDOW_ZOOM_LEVEL) {
                    this.updateZoomStatusBarItem();
                }
            });
        });
    }
    updateZoomStatusBarItem() {
        const zoomLevel = this.getZoomLevel();
        if (zoomLevel === 0) {
            // Hide the status bar item when zoom is at default level
            this.statusBar.removeElement(WindowZoomStatusBarItem_1.ID);
        }
        else {
            this.statusBar.setElement(WindowZoomStatusBarItem_1.ID, {
                name: common_1.nls.localizeByDefault('Window Zoom'),
                text: zoomLevel > 0 ? '$(codicon-zoom-in)' : '$(codicon-zoom-out)',
                alignment: browser_1.StatusBarAlignment.RIGHT,
                priority: 110,
                tooltip: () => this.createTooltip(zoomLevel),
                backgroundColor: 'var(--theia-statusBarItem-prominentBackground)',
                color: 'var(--theia-statusBarItem-prominentForeground)'
            });
        }
    }
    getZoomLevel() {
        return this.preferenceService.get(electron_window_preferences_1.PREF_WINDOW_ZOOM_LEVEL, 0);
    }
    createTooltip(zoomLevel) {
        const container = document.createElement('div');
        container.className = 'window-zoom-action-bar';
        (0, window_zoom_action_bar_1.renderWindowZoomActionBar)(container, zoomLevel, this.commandRegistry, this.keybindingRegistry);
        return container;
    }
};
exports.WindowZoomStatusBarItem = WindowZoomStatusBarItem;
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.StatusBar),
    tslib_1.__metadata("design:type", Object)
], WindowZoomStatusBarItem.prototype, "statusBar", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.PreferenceService),
    tslib_1.__metadata("design:type", Object)
], WindowZoomStatusBarItem.prototype, "preferenceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.CommandRegistry),
    tslib_1.__metadata("design:type", common_1.CommandRegistry)
], WindowZoomStatusBarItem.prototype, "commandRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.KeybindingRegistry),
    tslib_1.__metadata("design:type", browser_1.KeybindingRegistry)
], WindowZoomStatusBarItem.prototype, "keybindingRegistry", void 0);
exports.WindowZoomStatusBarItem = WindowZoomStatusBarItem = WindowZoomStatusBarItem_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], WindowZoomStatusBarItem);
//# sourceMappingURL=window-zoom-status-bar-item.js.map