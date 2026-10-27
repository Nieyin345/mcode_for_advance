"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WindowZoomActionBar = void 0;
exports.renderWindowZoomActionBar = renderWindowZoomActionBar;
const jsx_runtime_1 = require("react/jsx-runtime");
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
const client_1 = require("react-dom/client");
const React = require("../../../shared/react");
const browser_1 = require("../../browser");
const common_1 = require("../../common");
const electron_window_preferences_1 = require("../../electron-common/electron-window-preferences");
const electron_menu_contribution_1 = require("../menu/electron-menu-contribution");
class WindowZoomActionBar extends React.Component {
    getTitleWithKeybinding(command) {
        const bindings = this.props.keybindingRegistry.getKeybindingsForCommand(command.id);
        // Only consider the first active keybinding.
        if (bindings.length) {
            const binding = bindings.find(b => this.props.keybindingRegistry.isEnabledInScope(b, this.props.container));
            if (binding) {
                const accelerator = this.props.keybindingRegistry.acceleratorFor(binding, '+', true);
                return `${command.label} (${accelerator})`;
            }
        }
        return command.label;
    }
    renderActionButton(command, iconName, commandArgs = []) {
        return ((0, jsx_runtime_1.jsx)("div", { className: `${browser_1.ACTION_ITEM} window-zoom-button`, role: 'button', tabIndex: 0, "aria-label": command.label, title: this.getTitleWithKeybinding(command), onClick: () => this.props.commandRegistry.executeCommand(command.id, ...commandArgs), onKeyDown: e => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.props.commandRegistry.executeCommand(command.id, ...commandArgs);
                }
            }, children: iconName ? (0, jsx_runtime_1.jsx)("div", { className: (0, browser_1.codicon)(iconName) }) : (0, jsx_runtime_1.jsx)("div", { children: command.label }) }));
    }
    renderZoomDisplay() {
        const percentage = Math.round(100 * Math.pow(electron_window_preferences_1.ZoomLevel.ZOOM_BASE, this.props.zoomLevel));
        const zoomLevelText = common_1.nls.localizeByDefault('Zoom Level: {0} ({1}%)', this.props.zoomLevel.toString(), percentage.toString());
        return ((0, jsx_runtime_1.jsx)("div", { className: 'window-zoom-display', role: 'status', "aria-live": 'polite', "aria-atomic": 'true', "aria-label": zoomLevelText, title: zoomLevelText, children: (0, jsx_runtime_1.jsx)("div", { children: this.props.zoomLevel }) }));
    }
    render() {
        return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [this.renderActionButton(electron_menu_contribution_1.ElectronCommands.ZOOM_OUT, 'remove'), this.renderZoomDisplay(), this.renderActionButton(electron_menu_contribution_1.ElectronCommands.ZOOM_IN, 'plus'), this.renderActionButton(electron_menu_contribution_1.ElectronCommands.RESET_ZOOM), this.renderActionButton(browser_1.CommonCommands.OPEN_PREFERENCES, 'settings-gear', [electron_window_preferences_1.PREF_WINDOW_ZOOM_LEVEL])] }));
    }
}
exports.WindowZoomActionBar = WindowZoomActionBar;
/**
 * Helper function to render the WindowZoomActionBar React component into a DOM container element.
 * This function can be called from a TypeScript file without JSX.
 */
function renderWindowZoomActionBar(container, zoomLevel, commandRegistry, keybindingRegistry) {
    const root = (0, client_1.createRoot)(container);
    root.render((0, jsx_runtime_1.jsx)(WindowZoomActionBar, { container: container, zoomLevel: zoomLevel, commandRegistry: commandRegistry, keybindingRegistry: keybindingRegistry }));
}
//# sourceMappingURL=window-zoom-action-bar.js.map