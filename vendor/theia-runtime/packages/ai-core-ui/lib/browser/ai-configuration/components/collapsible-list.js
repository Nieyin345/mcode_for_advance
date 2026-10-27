"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CollapsibleRowAction = exports.CollapsibleList = void 0;
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
const browser_1 = require("@theia/core/lib/browser");
const React = require("@theia/core/shared/react");
const ai_configuration_primitives_1 = require("./ai-configuration-primitives");
const ai_configuration_origin_badge_1 = require("./ai-configuration-origin-badge");
/**
 * A filterable list of expandable rows grouped under titled sections, available to any
 * {@link AiConfigurationCategory} that presents a long, browsable list (the Variables and the
 * Skills & Slash Commands pages use it). Owns the local filter and per-row expansion state so both
 * reset when the page is navigated away from (the component unmounts).
 *
 * All classes are prefixed `ai-config-collapsible-` and are styled in `ai-configuration-components.css`.
 */
const CollapsibleList = ({ groups, filterPlaceholder, emptyMessage, filterEmptyMessage }) => {
    const [filter, setFilter] = React.useState('');
    const [expanded, setExpanded] = React.useState(() => new Set());
    const toggle = React.useCallback((id) => setExpanded(previous => {
        const next = new Set(previous);
        if (next.has(id)) {
            next.delete(id);
        }
        else {
            next.add(id);
        }
        return next;
    }), []);
    const query = filter.trim().toLocaleLowerCase();
    const filtering = query.length > 0;
    const visibleGroups = groups
        .map(group => ({ group, rows: filtering ? group.rows.filter(row => row.filterText.includes(query)) : group.rows }))
        .filter(entry => entry.rows.length > 0);
    return (0, jsx_runtime_1.jsxs)("div", { className: 'ai-config-collapsible-list', children: [(0, jsx_runtime_1.jsx)(ai_configuration_primitives_1.AiConfigurationFilterInput, { value: filter, onChange: setFilter, placeholder: filterPlaceholder }), visibleGroups.length === 0
                ? (0, jsx_runtime_1.jsx)(ai_configuration_primitives_1.AiConfigurationEmptyState, { iconClass: (0, browser_1.codicon)('search'), message: filtering ? filterEmptyMessage(filter.trim()) : emptyMessage })
                : (0, jsx_runtime_1.jsx)("div", { className: 'ai-configuration-sections', children: visibleGroups.map(({ group, rows }) => (0, jsx_runtime_1.jsx)(CollapsibleGroupView, { title: group.title, description: group.description, rows: rows, expanded: expanded, onToggle: toggle, filtering: filtering }, group.id)) })] });
};
exports.CollapsibleList = CollapsibleList;
const CollapsibleGroupView = ({ title, description, rows, expanded, onToggle, filtering }) => 
// The count is of the rows actually shown, so it tracks the filter rather than promising hidden entries.
(0, jsx_runtime_1.jsxs)(ai_configuration_primitives_1.AiConfigurationSection, { title: title, count: rows.length, collapsible: true, forceExpanded: filtering, className: 'ai-config-collapsible-group', children: [description && (0, jsx_runtime_1.jsx)("div", { className: 'ai-config-collapsible-group-description', children: description }), rows.map(row => (0, jsx_runtime_1.jsx)(CollapsibleRowView, { row: row, expanded: expanded.has(row.id), onToggle: onToggle }, row.id))] });
/**
 * One icon action in a {@link CollapsibleRow}'s trailing slot. Stops the click from reaching the header,
 * which would otherwise expand or collapse the row.
 */
const CollapsibleRowAction = ({ iconClass, label, disabled, onActivate }) => ((0, jsx_runtime_1.jsx)("button", { type: 'button', className: 'ai-config-collapsible-row-action', "aria-label": label, title: label, disabled: disabled, onClick: event => {
        event.stopPropagation();
        onActivate();
    }, children: (0, jsx_runtime_1.jsx)("span", { "aria-hidden": 'true', className: iconClass }) }));
exports.CollapsibleRowAction = CollapsibleRowAction;
const CollapsibleRowView = ({ row, expanded, onToggle }) => {
    const bodyId = `ai-collapsible-body-${row.id}`;
    const toggle = React.useCallback(() => onToggle(row.id), [onToggle, row.id]);
    // Only toggle when the header itself has focus; keystrokes on nested controls (the action button)
    // must not bubble up and collapse the row.
    const onHeaderKeyDown = React.useCallback((event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            toggle();
        }
    }, [toggle]);
    return (0, jsx_runtime_1.jsxs)("div", { className: 'ai-config-collapsible-row', "data-ai-config-row-id": row.id, children: [(0, jsx_runtime_1.jsxs)("div", { className: `ai-config-collapsible-row-header ${expanded ? 'expanded' : ''}`, role: 'button', tabIndex: 0, "aria-expanded": expanded, "aria-controls": expanded ? bodyId : undefined, onClick: toggle, onKeyDown: onHeaderKeyDown, children: [(0, jsx_runtime_1.jsx)("span", { "aria-hidden": 'true', className: `ai-config-collapsible-expansion-icon ${(0, browser_1.codicon)(expanded ? 'chevron-down' : 'chevron-right')}` }), (0, jsx_runtime_1.jsx)("span", { className: 'ai-config-collapsible-row-title', children: row.title }), expanded
                        ? (0, jsx_runtime_1.jsx)("span", { className: 'ai-config-collapsible-inline-description-spacer', "aria-hidden": 'true' })
                        : (0, jsx_runtime_1.jsx)("span", { className: 'ai-config-collapsible-inline-description', title: row.description || undefined, children: row.description }), ((row.pills && row.pills.length > 0) || (row.origins && row.origins.length > 0)) && (0, jsx_runtime_1.jsxs)("div", { className: 'ai-config-collapsible-row-meta', children: [row.pills?.map((pill, index) => (0, jsx_runtime_1.jsx)("span", { className: 'ai-config-collapsible-count-pill', children: pill }, index)), (0, jsx_runtime_1.jsx)(ai_configuration_origin_badge_1.AiConfigurationOriginBadges, { origins: row.origins })] }), row.actions && (0, jsx_runtime_1.jsx)("div", { className: 'ai-config-collapsible-row-actions', children: row.actions })] }), expanded && (0, jsx_runtime_1.jsxs)("div", { className: 'ai-config-collapsible-row-body', id: bodyId, children: [row.description && (0, jsx_runtime_1.jsx)("p", { className: 'ai-config-collapsible-full-description', children: row.description }), row.body] })] });
};
//# sourceMappingURL=collapsible-list.js.map