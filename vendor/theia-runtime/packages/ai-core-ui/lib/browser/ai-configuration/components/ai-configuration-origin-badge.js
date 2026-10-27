"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiConfigurationOriginBadges = exports.AiConfigurationOriginBadge = exports.AiConfigurationOrigin = void 0;
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
var AiConfigurationOrigin;
(function (AiConfigurationOrigin) {
    /**
     * An entry installed from, or linked to, an AI registry approval.
     *
     * @param open reveals the entry in the registry UI. Omit it where no registry UI is bound: the entry
     * still came from the registry, which is worth stating, so the badge is shown - just not as a link.
     */
    function registry(entryId, open) {
        return {
            label: core_1.nls.localize('theia/ai/core/aiConfiguration/origin/fromRegistry', 'From registry'),
            iconClass: (0, browser_1.codicon)('link-external'),
            tooltip: open
                ? core_1.nls.localize('theia/ai/core/aiConfiguration/origin/openInRegistry', 'Open in AI registry: {0}', entryId)
                : core_1.nls.localize('theia/ai/core/aiConfiguration/origin/registryEntry', 'AI registry entry: {0}', entryId),
            activate: open
        };
    }
    AiConfigurationOrigin.registry = registry;
    /**
     * An entry contributed by an installed Agent Plugin. Takes the resolved plugin rather than its
     * identifier: a bare identifier is not worth showing, so a caller that cannot resolve one renders no
     * badge at all.
     */
    function agentPlugin(plugin, reveal) {
        return {
            label: core_1.nls.localize('theia/ai/core/aiConfiguration/origin/viaAgentPlugin', 'via {0}', plugin.name),
            // `package`, matching the Agent Plugin cards in the Extensions view; `extensions` is the icon
            // that view's VS Code extension section owns.
            iconClass: (0, browser_1.codicon)('package'),
            tooltip: core_1.nls.localize('theia/ai/core/aiConfiguration/origin/openAgentPlugin', 'Open the Agent Plugin that provides this: {0}', plugin.name),
            activate: reveal
        };
    }
    AiConfigurationOrigin.agentPlugin = agentPlugin;
})(AiConfigurationOrigin || (exports.AiConfigurationOrigin = AiConfigurationOrigin = {}));
/**
 * One {@link AiConfigurationOrigin} as a pill next to an entry's name: a `<button>` when the origin can
 * be opened, a plain `<span>` when it cannot, so that only what is actually navigable is focusable.
 * The click never bubbles - these sit inside rows and headers that are themselves clickable, and
 * following the badge must not also open the row.
 */
const AiConfigurationOriginBadge = ({ origin }) => {
    const content = (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { "aria-hidden": 'true', className: `ai-configuration-origin-badge-icon ${origin.iconClass}` }), (0, jsx_runtime_1.jsx)("span", { className: 'ai-configuration-origin-badge-label', children: origin.label })] });
    return origin.activate
        ? (0, jsx_runtime_1.jsx)("button", { type: 'button', className: 'ai-configuration-origin-badge activatable', title: origin.tooltip, "aria-label": origin.tooltip, onClick: event => {
                event.stopPropagation();
                origin.activate();
            }, children: content })
        : (0, jsx_runtime_1.jsx)("span", { className: 'ai-configuration-origin-badge', title: origin.tooltip, children: content });
};
exports.AiConfigurationOriginBadge = AiConfigurationOriginBadge;
/** The origins of one entry, in the order given; nothing at all when it has none, which is the common case. */
const AiConfigurationOriginBadges = ({ origins }) => origins && origins.length > 0
    ? (0, jsx_runtime_1.jsx)("span", { className: 'ai-configuration-origin-badges', children: origins.map(origin => (0, jsx_runtime_1.jsx)(exports.AiConfigurationOriginBadge, { origin: origin }, origin.label)) })
    : undefined;
exports.AiConfigurationOriginBadges = AiConfigurationOriginBadges;
//# sourceMappingURL=ai-configuration-origin-badge.js.map