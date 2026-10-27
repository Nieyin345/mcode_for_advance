"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource GmbH and others.
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
exports.formatRelativeTime = formatRelativeTime;
exports.formatAbsoluteDate = formatAbsoluteDate;
exports.appendIconText = appendIconText;
exports.createHoverHr = createHoverHr;
exports.buildProviderTooltip = buildProviderTooltip;
exports.buildTooltipRefBadge = buildTooltipRefBadge;
exports.buildHtmlTooltip = buildHtmlTooltip;
const markdown_link_handler_1 = require("@theia/core/lib/browser/markdown-rendering/markdown-link-handler");
const markdown_string_1 = require("@theia/core/lib/common/markdown-rendering/markdown-string");
const widget_1 = require("@theia/core/lib/browser/widgets/widget");
const nls_1 = require("@theia/core/lib/common/nls");
const scm_history_graph_helpers_1 = require("./scm-history-graph-helpers");
function formatRelativeTime(ms) {
    const now = Date.now();
    const diffMs = now - ms;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);
    if (diffDay > 30) {
        return new Date(ms).toLocaleDateString();
    }
    if (diffDay >= 1) {
        return diffDay === 1
            ? nls_1.nls.localizeByDefault('{0} day ago', diffDay)
            : nls_1.nls.localizeByDefault('{0} days ago', diffDay);
    }
    if (diffHour >= 1) {
        return diffHour === 1
            ? nls_1.nls.localize('theia/scm/1HourAgo', '1 hour ago')
            : nls_1.nls.localizeByDefault('{0} hours ago', diffHour);
    }
    if (diffMin >= 1) {
        return diffMin === 1
            ? nls_1.nls.localize('theia/scm/1MinuteAgo', '1 minute ago')
            : nls_1.nls.localizeByDefault('{0} minutes ago', diffMin);
    }
    return nls_1.nls.localize('theia/scm/justNow', 'just now');
}
function formatAbsoluteDate(ms) {
    return new Date(ms).toLocaleString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
}
/**
 * Appends a theme icon `<i>` element followed by a text node into a container.
 */
function appendIconText(container, iconName, text) {
    const icon = document.createElement('i');
    icon.className = (0, widget_1.codicon)(iconName) + ' icon-inline';
    container.appendChild(icon);
    container.appendChild(document.createTextNode(` ${text}`));
}
function createHoverHr() {
    return document.createElement('hr');
}
/**
 * Renders the hover content supplied by the history provider, if any.
 *
 * Providers own their hover: `vscode.git`, for example, sends the same content as the blame
 * editor decoration hover, including the author `mailto:` link and the "Open Commit",
 * "Copy Commit Hash" and remote (e.g. "Open on GitHub") command links. Rendering it verbatim
 * keeps those actions working without the graph having to know any provider-specific command.
 *
 * Each section is rendered and wired separately so that a section only authorizes the commands
 * declared in its own {@link MarkdownString.isTrusted}. Sections are rendered as given, without
 * separators of our own: a provider that owns its hover also owns how its sections are delimited,
 * and `vscode.git` for one already ends them with a horizontal rule.
 *
 * @returns the rendered element, or `undefined` if the provider supplied no usable content.
 */
function buildProviderTooltip(tooltip, markdownRenderer, openerService, disposables) {
    const sections = (typeof tooltip === 'string' ? [new markdown_string_1.MarkdownStringImpl(tooltip)] : Array.isArray(tooltip) ? tooltip : [tooltip])
        .filter(section => section.value.trim().length > 0);
    if (sections.length === 0) {
        return undefined;
    }
    const container = document.createElement('div');
    container.className = 'scm-history-tooltip';
    for (const section of sections) {
        const rendered = markdownRenderer.render(section);
        disposables.push(rendered);
        disposables.push((0, markdown_link_handler_1.wireMarkdownLinkHandler)(rendered.element, section, openerService));
        container.appendChild(rendered.element);
    }
    return container;
}
/**
 * Appends the author part of the tooltip header: the avatar image (or account
 * icon) followed by the bold author name, linked via `mailto:` when the email
 * is known — the same structure as the git blame editor decoration hover.
 */
function appendAuthor(container, item) {
    if (item.authorIcon && (item.authorIcon.startsWith('http://') || item.authorIcon.startsWith('https://'))) {
        const avatar = document.createElement('img');
        avatar.className = 'scm-history-tooltip-avatar';
        avatar.src = item.authorIcon;
        container.appendChild(avatar);
    }
    else {
        const icon = document.createElement('i');
        icon.className = (0, widget_1.codicon)('account') + ' icon-inline';
        container.appendChild(icon);
    }
    container.appendChild(document.createTextNode(' '));
    const name = document.createElement('strong');
    name.textContent = item.author;
    if (item.authorEmail) {
        const link = document.createElement('a');
        link.href = `mailto:${item.authorEmail}`;
        link.appendChild(name);
        container.appendChild(link);
    }
    else {
        container.appendChild(name);
    }
}
/** Creates a clickable tooltip action (icon + optional label). */
function createTooltipAction(title, iconName, label, onClick) {
    const action = document.createElement('a');
    action.className = 'scm-history-tooltip-action';
    action.title = title;
    action.setAttribute('role', 'button');
    const icon = document.createElement('i');
    icon.className = (0, widget_1.codicon)(iconName) + ' icon-inline';
    action.appendChild(icon);
    if (label) {
        action.appendChild(document.createTextNode(` ${label}`));
    }
    action.onclick = e => {
        e.preventDefault();
        onClick();
    };
    return action;
}
/** Creates a ref badge element for the HTML tooltip. */
function buildTooltipRefBadge(ref, iconClass, showText, bgColor, extraClass) {
    const badge = document.createElement('span');
    badge.className = `scm-history-ref-badge ${(0, scm_history_graph_helpers_1.getRefBadgeClass)(ref)} tooltip-badge${extraClass ? ' ' + extraClass : ''}`;
    badge.title = ref.description ?? ref.name;
    badge.style.backgroundColor = bgColor;
    badge.style.color = 'var(--theia-scmGraph-historyItemRefForeground, var(--theia-badge-foreground))';
    const icon = document.createElement('i');
    icon.className = `codicon ${iconClass} scm-history-ref-icon`;
    badge.appendChild(icon);
    if (showText) {
        const text = document.createElement('span');
        text.className = 'scm-history-ref-text';
        text.textContent = ref.name;
        badge.appendChild(text);
    }
    return badge;
}
function buildHtmlTooltip(entry, markdownRenderer, provider, actions) {
    const { item } = entry;
    const badgeColor = (0, scm_history_graph_helpers_1.laneColor)(entry.graphRow.color);
    const container = document.createElement('div');
    container.className = 'scm-history-tooltip';
    // Header - avatar/account icon, bold author (mailto link), relative + absolute date,
    // matching the git blame editor decoration hover
    if (item.author || item.timestamp !== undefined) {
        const header = document.createElement('div');
        header.className = 'scm-history-tooltip-header';
        if (item.author) {
            appendAuthor(header, item);
        }
        if (item.timestamp !== undefined) {
            if (item.author) {
                header.appendChild(document.createTextNode(',\u00a0'));
            }
            const timeSpan = document.createElement('span');
            appendIconText(timeSpan, 'history', `${formatRelativeTime(item.timestamp)} (${formatAbsoluteDate(item.timestamp)})`);
            header.appendChild(timeSpan);
        }
        container.appendChild(header);
        container.appendChild(createHoverHr());
    }
    // Body
    const bodyText = (item.message && item.message.trim() !== item.subject.trim())
        ? item.message.trim()
        : item.subject;
    const bodyMd = new markdown_string_1.MarkdownStringImpl(bodyText);
    const rendered = markdownRenderer.render(bodyMd);
    container.appendChild(rendered.element);
    // Stats
    if (item.statistics) {
        const s = item.statistics;
        container.appendChild(createHoverHr());
        const stats = document.createElement('div');
        stats.className = 'scm-history-tooltip-stats';
        const fileCount = s.files === 1 ? '1 file changed' : `${s.files} files changed`;
        const filesStrong = document.createElement('strong');
        filesStrong.textContent = fileCount;
        stats.appendChild(filesStrong);
        if (s.insertions > 0) {
            stats.appendChild(document.createTextNode(', '));
            const ins = document.createElement('span');
            ins.className = 'scm-history-stat-added';
            ins.textContent = `${s.insertions} insertion${s.insertions === 1 ? '' : 's'}(+)`;
            stats.appendChild(ins);
        }
        if (s.deletions > 0) {
            stats.appendChild(document.createTextNode(', '));
            const del = document.createElement('span');
            del.className = 'scm-history-stat-deleted';
            del.textContent = `${s.deletions} deletion${s.deletions === 1 ? '' : 's'}(-)`;
            stats.appendChild(del);
        }
        container.appendChild(stats);
    }
    // Refs + hash
    const shortHash = item.displayId ?? item.id.substring(0, 7);
    const hasActions = !!(actions?.openCommit || actions?.copyCommitHash);
    const hasRefs = item.references && item.references.length > 0;
    if (hasRefs || (!hasActions && item.displayId)) {
        container.appendChild(createHoverHr());
        const refsRow = document.createElement('div');
        refsRow.className = 'scm-history-tooltip-refs';
        refsRow.style.display = 'flex';
        refsRow.style.flexWrap = 'wrap';
        refsRow.style.gap = '4px';
        refsRow.style.alignItems = 'center';
        if (hasRefs) {
            const deduplicated = (0, scm_history_graph_helpers_1.deduplicateRefs)(item.references);
            for (const { ref, hasBoth } of deduplicated) {
                // Current/remote/base refs are colored by role, others by the row's lane color
                const { iconClass, colorIndex } = (0, scm_history_graph_helpers_1.getRefBadgePresentation)(ref, provider);
                const bgColor = colorIndex !== undefined ? (0, scm_history_graph_helpers_1.laneColor)(colorIndex) : badgeColor;
                refsRow.appendChild(buildTooltipRefBadge(ref, iconClass, true, bgColor));
                if (!(0, scm_history_graph_helpers_1.isTagRef)(ref) && !(0, scm_history_graph_helpers_1.isRemoteRef)(ref) && hasBoth) {
                    refsRow.appendChild(buildTooltipRefBadge(ref, 'codicon-cloud', false, bgColor, 'scm-history-ref-badge-cloud'));
                }
            }
        }
        if (!hasActions && item.displayId) {
            const hash = document.createElement('code');
            hash.textContent = item.displayId;
            refsRow.appendChild(hash);
        }
        container.appendChild(refsRow);
    }
    // Actions — commit hash and copy, matching the git blame hover's command links
    if (hasActions) {
        container.appendChild(createHoverHr());
        const actionsRow = document.createElement('div');
        actionsRow.className = 'scm-history-tooltip-actions';
        if (actions?.openCommit) {
            actionsRow.appendChild(createTooltipAction(nls_1.nls.localize('theia/scm/openCommit', 'Open Commit'), 'git-commit', shortHash, actions.openCommit));
        }
        if (actions?.copyCommitHash) {
            if (actions.openCommit) {
                actionsRow.appendChild(document.createTextNode('  '));
            }
            actionsRow.appendChild(createTooltipAction(nls_1.nls.localizeByDefault('Copy Commit Hash'), 'copy', undefined, actions.copyCommitHash));
        }
        container.appendChild(actionsRow);
    }
    return container;
}
//# sourceMappingURL=scm-history-graph-tooltip.js.map