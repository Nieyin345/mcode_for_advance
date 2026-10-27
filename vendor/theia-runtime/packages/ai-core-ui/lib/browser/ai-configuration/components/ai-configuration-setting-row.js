"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiSettingGearButton = exports.AiConfigurationSettingRow = void 0;
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
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
const core_1 = require("@theia/core");
const browser_1 = require("@theia/core/lib/browser");
const React = require("@theia/core/shared/react");
const ai_configuration_primitives_1 = require("./ai-configuration-primitives");
/**
 * Presentational per-setting row shared across every AI configuration page: title, the schema
 * description, a control (inline via {@link AiConfigurationSettingRowProps.control} or full-width via
 * {@link AiConfigurationSettingRowProps.below}), a modified edge when overridden in the current scope,
 * and a gear menu (mirroring the Settings UI) offering "Copy Setting ID" and "Reset Setting". It is
 * DI-free; owners supply the values, a bound markdown renderer and the callbacks.
 */
const AiConfigurationSettingRow = ({ preferenceId, title, description, renderMarkdown, modified, tags, onOpenMenu, control, below, actions }) => ((0, jsx_runtime_1.jsxs)("div", { className: `ai-settings-row${modified ? ' modified' : ''}`, "data-ai-config-row-id": preferenceId, children: [(0, jsx_runtime_1.jsx)(AiSettingRowGear, { onOpenMenu: onOpenMenu }), (0, jsx_runtime_1.jsxs)("div", { className: 'ai-settings-row-top', children: [(0, jsx_runtime_1.jsxs)("div", { className: 'ai-settings-row-main', children: [(0, jsx_runtime_1.jsxs)("div", { className: 'ai-settings-row-title', children: [title, tags && tags.length > 0 && (0, jsx_runtime_1.jsx)("span", { className: 'ai-settings-row-tags', children: tags.map(tag => ((0, jsx_runtime_1.jsx)("span", { className: 'ai-settings-row-tag', title: tagTooltip(tag), children: tagLabel(tag) }, tag))) })] }), description !== undefined && (typeof description === 'string' && renderMarkdown
                            ? (0, jsx_runtime_1.jsx)(ai_configuration_primitives_1.AiMarkdownDescription, { renderMarkdown: renderMarkdown, markdown: description })
                            : (0, jsx_runtime_1.jsx)("div", { className: 'ai-settings-row-description', children: description }))] }), (0, jsx_runtime_1.jsxs)("div", { className: 'ai-settings-row-control', children: [control, actions] })] }), below && (0, jsx_runtime_1.jsx)("div", { className: 'ai-settings-row-below', children: below })] }));
exports.AiConfigurationSettingRow = AiConfigurationSettingRow;
/** Badge text for a preference tag, matching the Settings UI (experimental/preview localized; else the raw tag). */
function tagLabel(tag) {
    return tag === 'experimental' ? core_1.nls.localizeByDefault('Experimental')
        : tag === 'preview' ? core_1.nls.localizeByDefault('Preview')
            : tag;
}
/** Hover text for a preference tag badge, matching the Settings UI. */
function tagTooltip(tag) {
    if (tag === 'experimental') {
        return core_1.nls.localizeByDefault('Experimental setting: this setting controls a new feature that is actively being developed and may be unstable. It is subject to change or removal.');
    }
    if (tag === 'preview') {
        return core_1.nls.localizeByDefault('Preview setting: this setting controls a new feature that is still under refinement yet ready to use. Feedback is welcome.');
    }
    return tag;
}
/**
 * Gear affordance in the row's left gutter, matching the Settings UI: a cog button (outside the content,
 * so it never shifts the title) that opens the preference context menu via
 * {@link AiConfigurationSettingRowProps.onOpenMenu}. That opener renders a real Theia context menu
 * (`AI_CONFIGURATION_SETTING_CONTEXT_MENU`), so no popover is implemented here. Hidden when no opener
 * is given.
 */
const AiSettingRowGear = ({ onOpenMenu }) => {
    if (!onOpenMenu) {
        return undefined;
    }
    return (0, jsx_runtime_1.jsx)("div", { className: 'ai-settings-row-actions', children: (0, jsx_runtime_1.jsx)(exports.AiSettingGearButton, { onOpenMenu: onOpenMenu }) });
};
/**
 * The bare cog button that opens a row's context menu, shared by {@link AiConfigurationSettingRow} and the
 * list {@link AiConfigurationItemRow} so both surface the identical gear affordance. It renders no wrapper,
 * so each host places it (the setting row in its left gutter, the item row in its trailing cluster).
 */
const AiSettingGearButton = ({ onOpenMenu }) => {
    const open = React.useCallback((event) => {
        onOpenMenu(event.currentTarget);
    }, [onOpenMenu]);
    const label = core_1.nls.localizeByDefault('More Actions...');
    return (0, jsx_runtime_1.jsx)("button", { type: 'button', className: `ai-settings-row-gear ${(0, browser_1.codicon)('settings-gear')}`, title: label, "aria-label": label, "aria-haspopup": 'menu', onClick: open });
};
exports.AiSettingGearButton = AiSettingGearButton;
//# sourceMappingURL=ai-configuration-setting-row.js.map