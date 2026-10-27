"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiConfigurationItemRow = void 0;
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
const ai_configuration_origin_badge_1 = require("./ai-configuration-origin-badge");
const ai_configuration_setting_row_1 = require("./ai-configuration-setting-row");
/**
 * A row's description, clamped to two lines so a long list stays scannable, with a toggle that reveals the
 * rest in place. Without it the remainder of a long description (a tool's, in particular, often runs to
 * several sentences) was simply unreachable; showing every description in full instead made the Tools page
 * far too long to scroll.
 *
 * The toggle appears only once the text is measured as actually clamped, since that depends on the rendered
 * width; measuring is skipped while expanded, where the clamp is lifted and nothing overflows.
 */
const AiConfigurationItemRowDescription = ({ description }) => {
    const [expanded, setExpanded] = React.useState(false);
    const [clamped, setClamped] = React.useState(false);
    // eslint-disable-next-line no-null/no-null
    const descriptionRef = React.useRef(null);
    React.useLayoutEffect(() => {
        const element = descriptionRef.current;
        if (!element || expanded) {
            return;
        }
        // Sub-pixel line heights make an unclamped element report a slightly larger scroll height.
        const measure = () => setClamped(element.scrollHeight - element.clientHeight > 1);
        measure();
        // Narrowing the view can clamp a description that fit before, so re-measure on width changes.
        // Guarded because JSDOM, which the component specs render into, has no `ResizeObserver`.
        if (typeof ResizeObserver === 'undefined') {
            return;
        }
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [description, expanded]);
    const onToggle = (event) => {
        // A navigable row would otherwise also handle the click and open its own detail.
        event.stopPropagation();
        setExpanded(previous => !previous);
    };
    return (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("span", { ref: descriptionRef, className: `ai-configuration-item-row-description${expanded ? ' expanded' : ''}`, children: description }), clamped && (0, jsx_runtime_1.jsx)("button", { type: 'button', className: 'ai-configuration-item-row-description-toggle', "aria-expanded": expanded, onClick: onToggle, children: expanded ? core_1.nls.localizeByDefault('Show Less') : core_1.nls.localizeByDefault('Show More') })] });
};
/**
 * Overview row for a collection item: an icon, a label with an optional description, and a right-hand slot
 * for a status badge / stats / an inline control. When {@link AiConfigurationItemRowProps.onSelect} is given
 * the whole row is a single navigable control (click or Enter/Space) that opens the item's detail page,
 * ending in a chevron; without it the row simply presents its trailing control. A flat, list-style
 * alternative to a card grid, matching the Settings and extensions lists; every non-label slot is optional.
 */
const AiConfigurationItemRow = ({ label, rowId, tags, origins, monospaceLabel, iconClass, description, status, modified, trailing, onOpenMenu, onSelect, onActivateLabel, labelTooltip }) => {
    const navigable = onSelect !== undefined;
    const onKeyDown = (event) => {
        if (onSelect && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            onSelect();
        }
    };
    return (0, jsx_runtime_1.jsxs)("div", { className: `ai-configuration-item-row${navigable ? ' navigable' : ''}${modified ? ' modified' : ''}`, "data-ai-config-row-id": rowId, role: navigable ? 'button' : undefined, tabIndex: navigable ? 0 : undefined, onClick: onSelect, onKeyDown: navigable ? onKeyDown : undefined, children: [onOpenMenu && (0, jsx_runtime_1.jsx)("div", { className: 'ai-configuration-item-row-actions', children: (0, jsx_runtime_1.jsx)(ai_configuration_setting_row_1.AiSettingGearButton, { onOpenMenu: onOpenMenu }) }), iconClass && (0, jsx_runtime_1.jsx)("span", { className: `ai-configuration-item-row-icon ${iconClass}` }), (0, jsx_runtime_1.jsxs)("div", { className: 'ai-configuration-item-row-text', children: [(0, jsx_runtime_1.jsxs)("div", { className: 'ai-configuration-item-row-heading', children: [onActivateLabel
                                ? (0, jsx_runtime_1.jsx)("button", { type: 'button', className: `ai-configuration-item-row-label link${monospaceLabel ? ' mono' : ''}`, title: labelTooltip, onClick: event => {
                                        // A navigable row would otherwise also handle the click and open its own detail.
                                        event.stopPropagation();
                                        onActivateLabel();
                                    }, children: label })
                                : (0, jsx_runtime_1.jsx)("span", { className: `ai-configuration-item-row-label${monospaceLabel ? ' mono' : ''}`, children: label }), tags && tags.length > 0 && (0, jsx_runtime_1.jsx)("span", { className: 'ai-configuration-item-row-tags', children: tags.map(tag => typeof tag === 'string'
                                    ? (0, jsx_runtime_1.jsx)(ai_configuration_primitives_1.AiConfigurationKindBadge, { label: tag, variant: 'outline' }, tag)
                                    : (0, jsx_runtime_1.jsx)(ai_configuration_primitives_1.AiConfigurationKindBadge, { label: tag.label, title: tag.title, variant: 'outline' }, tag.label)) }), (0, jsx_runtime_1.jsx)(ai_configuration_origin_badge_1.AiConfigurationOriginBadges, { origins: origins })] }), description && (0, jsx_runtime_1.jsx)(AiConfigurationItemRowDescription, { description: description })] }), (0, jsx_runtime_1.jsxs)("div", { className: 'ai-configuration-item-row-trailing', children: [status && (0, jsx_runtime_1.jsx)(ai_configuration_primitives_1.AiConfigurationStatusBadge, { status: status }), trailing, navigable && (0, jsx_runtime_1.jsx)("span", { className: `ai-configuration-item-row-chevron ${(0, browser_1.codicon)('chevron-right')}`, "aria-hidden": true })] })] });
};
exports.AiConfigurationItemRow = AiConfigurationItemRow;
//# sourceMappingURL=ai-configuration-item-row.js.map