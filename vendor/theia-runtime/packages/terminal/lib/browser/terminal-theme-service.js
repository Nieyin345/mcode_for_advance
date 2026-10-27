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
exports.TerminalThemeService = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const color_registry_1 = require("@theia/core/lib/browser/color-registry");
const theming_1 = require("@theia/core/lib/browser/theming");
const terminal_preferences_1 = require("../common/terminal-preferences");
let TerminalThemeService = class TerminalThemeService {
    get onDidChange() {
        return this.themeService.onDidColorThemeChange;
    }
    get theme() {
        const foregroundColor = this.colorRegistry.getCurrentColor('terminal.foreground');
        const backgroundColor = this.colorRegistry.getCurrentColor('terminal.background') || this.colorRegistry.getCurrentColor('panel.background');
        const cursorColor = this.colorRegistry.getCurrentColor('terminalCursor.foreground') || foregroundColor;
        const cursorAccentColor = this.colorRegistry.getCurrentColor('terminalCursor.background') || backgroundColor;
        const selectionBackgroundColor = this.colorRegistry.getCurrentColor('terminal.selectionBackground');
        const selectionInactiveBackground = this.colorRegistry.getCurrentColor('terminal.inactiveSelectionBackground');
        const selectionForegroundColor = this.colorRegistry.getCurrentColor('terminal.selectionForeground');
        const theme = {
            background: backgroundColor,
            foreground: foregroundColor,
            cursor: cursorColor,
            cursorAccent: cursorAccentColor,
            selectionBackground: selectionBackgroundColor,
            selectionInactiveBackground: selectionInactiveBackground,
            selectionForeground: selectionForegroundColor
        };
        // eslint-disable-next-line guard-for-in
        for (const id in terminal_preferences_1.terminalAnsiColorMap) {
            const colorId = id.substring(13);
            const colorName = colorId.charAt(0).toLowerCase() + colorId.slice(1);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            theme[colorName] = this.colorRegistry.getCurrentColor(id);
        }
        return theme;
    }
};
exports.TerminalThemeService = TerminalThemeService;
tslib_1.__decorate([
    (0, inversify_1.inject)(color_registry_1.ColorRegistry),
    tslib_1.__metadata("design:type", color_registry_1.ColorRegistry)
], TerminalThemeService.prototype, "colorRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(theming_1.ThemeService),
    tslib_1.__metadata("design:type", theming_1.ThemeService)
], TerminalThemeService.prototype, "themeService", void 0);
exports.TerminalThemeService = TerminalThemeService = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], TerminalThemeService);
//# sourceMappingURL=terminal-theme-service.js.map