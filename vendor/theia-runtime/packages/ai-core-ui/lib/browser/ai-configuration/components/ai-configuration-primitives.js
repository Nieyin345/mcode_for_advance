"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiConfigurationItemDetailHeader = exports.AiConfigurationFilterInput = exports.AiMarkdownDescription = exports.AiConfigurationAddAction = exports.AiConfigurationEmptyState = exports.AiConfigurationValueRow = exports.AiConfigurationCallout = exports.AiConfigurationIconButton = exports.AiConfigurationSection = exports.AiConfigurationKindBadge = exports.AiConfigurationStatusBadge = void 0;
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
const ai_configuration_origin_badge_1 = require("./ai-configuration-origin-badge");
/**
 * Labeled status affordance: a colored dot paired with its text label, so the
 * state is legible at a glance rather than encoded in color alone. The full
 * detail (if any) stays on hover.
 */
const AiConfigurationStatusBadge = ({ status }) => ((0, jsx_runtime_1.jsxs)("span", { className: 'ai-configuration-status-badge', title: status.tooltip ?? status.label, children: [(0, jsx_runtime_1.jsx)("span", { className: 'ai-configuration-status-badge-label', children: status.label }), (0, jsx_runtime_1.jsx)("span", { className: `ai-configuration-status ai-configuration-status-${status.kind}`, "aria-hidden": true })] }));
exports.AiConfigurationStatusBadge = AiConfigurationStatusBadge;
/**
 * A small labeled pill classifying an item or a customization scope: "Variant Set", "Fragment",
 * "Slash Command", "Skill", "Built-in", "User", "Workspace". Complements the color-coded
 * {@link AiConfigurationStatusBadge} used for on/off/warn/error state.
 */
const AiConfigurationKindBadge = ({ label, variant = 'default', iconClass, title }) => ((0, jsx_runtime_1.jsxs)("span", { className: `ai-configuration-kind-badge ai-configuration-kind-badge-${variant}`, title: title ?? label, children: [iconClass && (0, jsx_runtime_1.jsx)("span", { className: `ai-configuration-kind-badge-icon ${iconClass}`, "aria-hidden": true }), (0, jsx_runtime_1.jsx)("span", { className: 'ai-configuration-kind-badge-label', children: label })] }));
exports.AiConfigurationKindBadge = AiConfigurationKindBadge;
/**
 * A titled group of settings rows in a detail page. Generalizes the earlier
 * `ConfigurationSection` and adds an optional subtitle and a right-aligned actions slot on the title line,
 * plus an optional entry count and folding for the sections that hold long lists.
 */
const AiConfigurationSection = ({ title, subtitle, count, collapsible, forceExpanded, actions, children, className }) => {
    const [expanded, setExpanded] = React.useState(true);
    const toggle = React.useCallback(() => setExpanded(previous => !previous), []);
    const onKeyDown = React.useCallback((event) => {
        // Only the title line itself toggles; keystrokes in the actions slot must not fold the section.
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            toggle();
        }
    }, [toggle]);
    const foldable = collapsible === true && title !== undefined;
    const showContent = !foldable || forceExpanded === true || expanded;
    return (0, jsx_runtime_1.jsxs)("div", { className: `ai-configuration-section ${className ?? ''}`, children: [(title !== undefined || actions) && (0, jsx_runtime_1.jsxs)("div", { className: `ai-configuration-section-title${foldable ? ' foldable' : ''}`, role: foldable ? 'button' : undefined, tabIndex: foldable ? 0 : undefined, "aria-expanded": foldable ? showContent : undefined, onClick: foldable ? toggle : undefined, onKeyDown: foldable ? onKeyDown : undefined, children: [foldable && (0, jsx_runtime_1.jsx)("span", { "aria-hidden": 'true', className: `ai-configuration-section-chevron ${(0, browser_1.codicon)(showContent ? 'chevron-down' : 'chevron-right')}` }), title !== undefined && (0, jsx_runtime_1.jsx)("span", { className: 'ai-configuration-section-title-text', children: title }), count !== undefined && (0, jsx_runtime_1.jsx)("span", { className: 'ai-configuration-section-count', children: count }), subtitle !== undefined && (0, jsx_runtime_1.jsx)("span", { className: 'ai-configuration-section-subtitle', children: subtitle }), actions && (0, jsx_runtime_1.jsx)("span", { className: 'ai-configuration-section-title-actions', children: actions })] }), showContent && (0, jsx_runtime_1.jsx)("div", { className: 'ai-configuration-section-content', children: children })] });
};
exports.AiConfigurationSection = AiConfigurationSection;
/**
 * A borderless icon-only action, for actions that sit next to what they act on (a section title, a
 * row) where a labeled button would dominate the line it is on. The label lives in the tooltip and
 * the accessible name, so the action is still nameable without being read out loud visually.
 */
const AiConfigurationIconButton = ({ iconClass, title, disabled, busy, className, onClick }) => ((0, jsx_runtime_1.jsx)("button", { type: 'button', className: `ai-configuration-icon-button${className ? ' ' + className : ''}`, title: title, "aria-label": title, disabled: disabled, onClick: onClick, children: (0, jsx_runtime_1.jsx)("span", { className: `${iconClass}${busy ? ' codicon-modifier-spin' : ''}`, "aria-hidden": true }) }));
exports.AiConfigurationIconButton = AiConfigurationIconButton;
/**
 * A page-level offer: one line of explanation next to one action ("allow the default tools", "reset every
 * customization"). Rendered as a box above the page content rather than a bare button on the filter line,
 * so the consequence is stated where the action is.
 *
 * The message is not always ours — a provider's failure ends up here — so it is clamped to three lines
 * and repeated as a tooltip, and the action keeps its place however long the message runs.
 */
const AiConfigurationCallout = ({ message, action }) => (0, jsx_runtime_1.jsxs)("div", { className: 'ai-configuration-callout', children: [(0, jsx_runtime_1.jsx)("span", { className: 'ai-configuration-callout-text', title: message, children: message }), action] });
exports.AiConfigurationCallout = AiConfigurationCallout;
/**
 * A read-only value with its label — an id, a file path, a frontmatter entry — and an optional copy button.
 * These values exist to be used elsewhere (pasted into a prompt, a terminal, a settings file), so copying
 * them should not require selecting the text by hand.
 */
const AiConfigurationValueRow = ({ label, value, onCopy }) => {
    const [copied, setCopied] = React.useState(false);
    const timeout = React.useRef(undefined);
    React.useEffect(() => () => {
        if (timeout.current !== undefined) {
            clearTimeout(timeout.current);
        }
    }, []);
    const copyLabel = core_1.nls.localizeByDefault('Copy');
    return (0, jsx_runtime_1.jsxs)("div", { className: 'ai-configuration-value-row', children: [label !== undefined && (0, jsx_runtime_1.jsx)("span", { className: 'ai-configuration-value-row-label', children: label }), (0, jsx_runtime_1.jsxs)("span", { className: 'ai-configuration-value-row-field', children: [(0, jsx_runtime_1.jsx)("code", { className: 'ai-configuration-value-row-value', children: value }), onCopy && (0, jsx_runtime_1.jsx)(exports.AiConfigurationIconButton, { iconClass: (0, browser_1.codicon)(copied ? 'check' : 'copy'), title: copyLabel, onClick: () => {
                            onCopy(value);
                            setCopied(true);
                            if (timeout.current !== undefined) {
                                clearTimeout(timeout.current);
                            }
                            timeout.current = setTimeout(() => setCopied(false), 1500);
                        } })] }), (0, jsx_runtime_1.jsx)("span", { className: 'ai-configuration-visually-hidden', "aria-live": 'polite', children: copied ? core_1.nls.localizeByDefault('Copied') : '' })] });
};
exports.AiConfigurationValueRow = AiConfigurationValueRow;
/** Placeholder shown when a collection has no items or a filter matches nothing. */
const AiConfigurationEmptyState = ({ message, iconClass, action, className }) => ((0, jsx_runtime_1.jsxs)("div", { className: `ai-configuration-empty-state ${className ?? ''}`, children: [iconClass && (0, jsx_runtime_1.jsx)("span", { className: `ai-configuration-empty-state-icon ${iconClass}` }), (0, jsx_runtime_1.jsx)("span", { className: 'ai-configuration-empty-state-message', children: message }), action !== undefined && (0, jsx_runtime_1.jsx)("div", { className: 'ai-configuration-empty-state-action', children: action })] }));
exports.AiConfigurationEmptyState = AiConfigurationEmptyState;
/** "Add …" button used on collection overviews and in empty states. */
const AiConfigurationAddAction = ({ label, iconClass, disabled, onClick }) => ((0, jsx_runtime_1.jsxs)("button", { className: 'theia-button ai-configuration-add-action', disabled: disabled, onClick: onClick, children: [(0, jsx_runtime_1.jsx)("span", { className: iconClass ?? (0, browser_1.codicon)('add') }), (0, jsx_runtime_1.jsx)("span", { className: 'ai-configuration-add-action-label', children: label })] }));
exports.AiConfigurationAddAction = AiConfigurationAddAction;
/**
 * Renders a (trusted, already-localized) markdown description via the provided renderer into a
 * managed element. Shared by every AI configuration page so descriptions render consistently.
 */
const AiMarkdownDescription = ({ renderMarkdown, markdown, className }) => {
    // eslint-disable-next-line no-null/no-null
    const host = React.useRef(null);
    React.useEffect(() => {
        const node = host.current;
        if (!node) {
            return;
        }
        node.replaceChildren(renderMarkdown(markdown));
        return () => node.replaceChildren();
    }, [renderMarkdown, markdown]);
    return (0, jsx_runtime_1.jsx)("div", { className: className ?? 'ai-settings-row-description', ref: host });
};
exports.AiMarkdownDescription = AiMarkdownDescription;
/**
 * In-list filter input: a controlled text field (the owning widget holds the value) with a leading filter
 * icon, trailing toggles and a clear button, and Escape-to-clear — mirroring the view's search input.
 */
const AiConfigurationFilterInput = ({ value, onChange, placeholder, toggles }) => {
    const onKeyDown = React.useCallback((event) => {
        if (event.key === 'Escape' && value.length > 0) {
            event.preventDefault();
            onChange('');
        }
    }, [value, onChange]);
    const clearLabel = core_1.nls.localizeByDefault('Clear');
    const actionCount = (toggles?.length ?? 0) + (value.length > 0 ? 1 : 0);
    return (0, jsx_runtime_1.jsxs)("div", { className: `ai-configuration-filter-input${actionCount > 1 ? ' with-toggles' : ''}`, children: [(0, jsx_runtime_1.jsx)("span", { className: `ai-configuration-filter-input-icon ${(0, browser_1.codicon)('filter')}` }), (0, jsx_runtime_1.jsx)("input", { className: 'theia-input', type: 'text', spellCheck: false, value: value, placeholder: placeholder ?? core_1.nls.localizeByDefault('Filter'), onChange: e => onChange(e.target.value), onKeyDown: onKeyDown }), (0, jsx_runtime_1.jsxs)("span", { className: 'ai-configuration-filter-input-actions', children: [toggles?.map(toggle => (0, jsx_runtime_1.jsx)("button", { type: 'button', className: `ai-configuration-filter-input-action ${toggle.iconClass}${toggle.active ? ' active' : ''}`, title: toggle.title, "aria-label": toggle.title, "aria-pressed": toggle.active, onClick: toggle.onToggle }, toggle.iconClass)), value.length > 0 && (0, jsx_runtime_1.jsx)("button", { type: 'button', className: `ai-configuration-filter-input-action ${(0, browser_1.codicon)('close')}`, title: clearLabel, "aria-label": clearLabel, onClick: () => onChange('') })] })] });
};
exports.AiConfigurationFilterInput = AiConfigurationFilterInput;
/** Header of a collection item's detail page: icon, title, subtitle, status badge and an actions slot. */
const AiConfigurationItemDetailHeader = ({ title, iconClass, subtitle, status, origins, titleSuffix, actions }) => ((0, jsx_runtime_1.jsxs)("div", { className: 'ai-configuration-item-detail-header', children: [(0, jsx_runtime_1.jsxs)("div", { className: 'ai-configuration-item-detail-header-heading', children: [iconClass && (0, jsx_runtime_1.jsx)("span", { className: `ai-configuration-item-detail-header-icon ${iconClass}` }), (0, jsx_runtime_1.jsxs)("div", { className: 'ai-configuration-item-detail-header-titles', children: [(0, jsx_runtime_1.jsxs)("span", { className: 'ai-configuration-item-detail-header-title-row', children: [(0, jsx_runtime_1.jsx)("span", { className: 'ai-configuration-item-detail-header-title', children: title }), (0, jsx_runtime_1.jsx)(ai_configuration_origin_badge_1.AiConfigurationOriginBadges, { origins: origins }), titleSuffix] }), subtitle !== undefined && (0, jsx_runtime_1.jsx)("span", { className: 'ai-configuration-item-detail-header-subtitle', children: subtitle })] })] }), (status || actions !== undefined) && (0, jsx_runtime_1.jsxs)("div", { className: 'ai-configuration-item-detail-header-actions', children: [status && (0, jsx_runtime_1.jsx)(exports.AiConfigurationStatusBadge, { status: status }), actions] })] }));
exports.AiConfigurationItemDetailHeader = AiConfigurationItemDetailHeader;
//# sourceMappingURL=ai-configuration-primitives.js.map