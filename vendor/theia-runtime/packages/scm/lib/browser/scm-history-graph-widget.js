"use strict";
var ScmHistoryGraphWidget_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScmHistoryGraphWidget = exports.SCM_HISTORY_ITEM_REF_CONTEXT_MENU = exports.SCM_HISTORY_ITEM_CONTEXT_MENU = exports.SCM_HISTORY_TITLE_MENU = void 0;
const tslib_1 = require("tslib");
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
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
const React = require("@theia/core/shared/react");
const react_virtuoso_1 = require("@theia/core/shared/react-virtuoso");
const inversify_1 = require("@theia/core/shared/inversify");
const react_widget_1 = require("@theia/core/lib/browser/widgets/react-widget");
const label_provider_1 = require("@theia/core/lib/browser/label-provider");
const hover_service_1 = require("@theia/core/lib/browser/hover-service");
const clipboard_service_1 = require("@theia/core/lib/browser/clipboard-service");
const markdown_renderer_1 = require("@theia/core/lib/browser/markdown-rendering/markdown-renderer");
const scm_history_graph_model_1 = require("./scm-history-graph-model");
const scm_service_1 = require("./scm-service");
const uri_1 = require("@theia/core/lib/common/uri");
const nls_1 = require("@theia/core/lib/common/nls");
const cancellation_1 = require("@theia/core/lib/common/cancellation");
const disposable_1 = require("@theia/core/lib/common/disposable");
const event_1 = require("@theia/core/lib/common/event");
const context_menu_renderer_1 = require("@theia/core/lib/browser/context-menu-renderer");
const opener_service_1 = require("@theia/core/lib/browser/opener-service");
const diff_uris_1 = require("@theia/core/lib/browser/diff-uris");
const scm_context_key_service_1 = require("./scm-context-key-service");
const scm_preferences_1 = require("../common/scm-preferences");
const scm_history_graph_helpers_1 = require("./scm-history-graph-helpers");
const core_1 = require("@theia/core");
const scm_history_graph_tooltip_1 = require("./scm-history-graph-tooltip");
/** Menu path matching the VS Code 'scm/history/title' contribution point (graph section toolbar). */
exports.SCM_HISTORY_TITLE_MENU = ['plugin_scm/history/title'];
/** Menu path matching the VS Code 'scm/historyItem/context' contribution point (commit row context menu). */
exports.SCM_HISTORY_ITEM_CONTEXT_MENU = ['plugin_scm/historyItem/context'];
/** Menu path matching the VS Code 'scm/historyItemRef/context' contribution point (ref badge context menu). */
exports.SCM_HISTORY_ITEM_REF_CONTEXT_MENU = ['plugin_scm/historyItemRef/context'];
// ── Layout constants ────────────────────────────────────────────────────────
const ROW_HEIGHT = 22;
/** Horizontal width of each lane column in the SVG — matches VS Code exactly. */
const LANE_WIDTH = 22;
/** Y position of the commit dot — vertically centered in the row. */
const DOT_CY = 11;
/** Indentation of one level of the change tree, in pixels. */
const TREE_INDENT = 8;
/** Shared empty set for history items whose change tree is fully expanded. */
const EMPTY_FOLDER_SET = new Set();
/**
 * Indentation for a row of the change tree. Like Theia's tree widget, the depth
 * is applied as padding rather than through a class, as it is not known upfront.
 */
function indentStyle(depth) {
    return depth > 0 ? { paddingLeft: `${4 + depth * TREE_INDENT}px` } : undefined;
}
/** Renders a ref badge as a JSX element for the commit row. */
function renderJsxRefBadge(ref, iconClass, showText, style, key, onContextMenu) {
    return ((0, jsx_runtime_1.jsxs)("span", { className: `scm-history-ref-badge ${(0, scm_history_graph_helpers_1.getRefBadgeClass)(ref)}`, title: ref.description ?? ref.name, style: style, onContextMenu: onContextMenu, children: [(0, jsx_runtime_1.jsx)("i", { className: `codicon ${iconClass} scm-history-ref-icon` }), showText && (0, jsx_runtime_1.jsx)("span", { className: 'scm-history-ref-text', children: ref.name })] }, key));
}
// ── Widget ──────────────────────────────────────────────────────────────────
let ScmHistoryGraphWidget = class ScmHistoryGraphWidget extends react_widget_1.ReactWidget {
    static { ScmHistoryGraphWidget_1 = this; }
    static { this.ID = 'scm-history-graph-widget'; }
    static { this.LABEL = nls_1.nls.localizeByDefault('Graph'); }
    constructor() {
        super();
        this.selectedIndex = -1;
        /** Handle on the virtualized list, used to scroll an entry into view. */
        this.listRef = React.createRef();
        /** Map from commit id → loaded changes (undefined = not loaded yet). */
        this.expandedChanges = new Map();
        /** Set of commit ids that are currently expanded. */
        this.expandedIds = new Set();
        /** Map from commit id → folder paths collapsed in its change tree. */
        this.collapsedFolders = new Map();
        /** Map from commit id → in-flight CancellationTokenSource for loadChanges. */
        this.loadChangesCts = new Map();
        /** Cleanup for the content of the hover currently being shown. */
        this.toDisposeOnHover = new disposable_1.DisposableCollection();
        this.onDidChangeToolbarItemsEmitter = new event_1.Emitter();
        /** Re-renders the part toolbar on model changes, e.g. to reflect the toggled state of the ref filter picker. */
        this.onDidChangeToolbarItems = this.onDidChangeToolbarItemsEmitter.event;
        this.handleEndReached = () => {
            if (this.model.hasMore && !this.model.loading) {
                this.model.loadMore();
            }
        };
        this.handleRowMouseEnter = (e, entry) => {
            this.toDisposeOnHover.dispose();
            this.hoverService.requestHover({
                content: this.buildTooltip(entry),
                target: e.currentTarget,
                position: 'right',
                interactive: true,
            });
        };
        this.handleFolderClick = (e, itemId, path) => {
            e.stopPropagation();
            this.toggleFolder(itemId, path);
        };
        this.handleChangeClick = (e, change, changeKey) => {
            e.stopPropagation();
            this.selectedChangeKey = changeKey;
            this.update();
            this.openChange(change);
        };
        this.handleRowContextMenu = (e, entry) => {
            e.preventDefault();
            e.stopPropagation();
            const repo = this.scmService.selectedRepository;
            if (!repo) {
                return;
            }
            const { item } = entry;
            if (item.references && item.references.length > 0) {
                this.scmContextKeys.scmHistoryItemRef.set(item.references[0].id);
            }
            else {
                this.scmContextKeys.scmHistoryItemRef.set(undefined);
            }
            const sourceControlHandle = repo.provider.handle;
            const args = sourceControlHandle !== undefined
                ? [{ sourceControlHandle }, { sourceControlHandle, id: item.id, type: 'historyItem' }]
                : [];
            this.contextMenuRenderer.render({
                menuPath: exports.SCM_HISTORY_ITEM_CONTEXT_MENU,
                anchor: e.nativeEvent,
                args,
                context: this.node
            });
        };
        this.handleRefBadgeContextMenu = (e, entry, ref) => {
            e.preventDefault();
            e.stopPropagation();
            const repo = this.scmService.selectedRepository;
            if (!repo) {
                return;
            }
            this.scmContextKeys.scmHistoryItemRef.set(ref.id);
            const sourceControlHandle = repo.provider.handle;
            const args = sourceControlHandle !== undefined
                ? [{ sourceControlHandle }, { sourceControlHandle, id: ref.id, type: 'historyItemRef' }]
                : [];
            this.contextMenuRenderer.render({
                menuPath: exports.SCM_HISTORY_ITEM_REF_CONTEXT_MENU,
                anchor: e.nativeEvent,
                args,
                context: this.node
            });
        };
        this.handleRowClick = (idx, entry) => {
            this.selectedIndex = idx;
            const { item } = entry;
            if (this.expandedIds.has(item.id)) {
                this.expandedIds.delete(item.id);
                this.collapsedFolders.delete(item.id);
                const cts = this.loadChangesCts.get(item.id);
                if (cts) {
                    cts.cancel();
                    cts.dispose();
                    this.loadChangesCts.delete(item.id);
                }
            }
            else {
                this.expandedIds.add(item.id);
                if (!this.expandedChanges.has(item.id)) {
                    this.loadChanges(entry);
                }
            }
            this.update();
        };
        this.handleLoadMore = () => {
            this.model.loadMore();
        };
        this.handleLoadMoreKey = (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                this.model.loadMore();
            }
        };
        this.id = ScmHistoryGraphWidget_1.ID;
        this.title.label = ScmHistoryGraphWidget_1.LABEL;
        this.title.caption = ScmHistoryGraphWidget_1.LABEL;
        this.title.closable = false;
        this.addClass('scm-history-graph-container');
        this.node.tabIndex = 0;
    }
    init() {
        this.toDispose.push(this.onDidChangeToolbarItemsEmitter);
        this.toDispose.push(this.model.onDidChange(() => {
            this.updateContextKeys();
            this.update();
            this.onDidChangeToolbarItemsEmitter.fire();
        }));
        this.toDispose.push(this.model.onDidRequestReveal(index => this.revealIndex(index)));
        this.toDispose.push(this.scmPreferences.onPreferenceChanged(e => {
            if (e.preferenceName.startsWith('scm.graph.')) {
                this.update();
            }
        }));
        this.toDispose.push({
            dispose: () => {
                for (const cts of this.loadChangesCts.values()) {
                    cts.cancel();
                    cts.dispose();
                }
                this.loadChangesCts.clear();
            }
        });
        this.toDispose.push(this.toDisposeOnHover);
        this.update();
    }
    /** Scrolls the entry at `index` into view and selects it. */
    revealIndex(index) {
        this.selectedIndex = index;
        this.selectedChangeKey = undefined;
        this.listRef.current?.scrollToIndex({ index, align: 'center' });
        this.update();
    }
    updateContextKeys() {
        const provider = this.model.provider;
        this.scmContextKeys.scmCurrentHistoryItemRefHasRemote.set(!!provider?.currentHistoryItemRemoteRef);
        this.scmContextKeys.scmCurrentHistoryItemRefHasBase.set(!!provider?.currentHistoryItemBaseRef);
        // Commands like git.pullRef/git.pushRef gate their enablement on this key.
        this.scmContextKeys.scmCurrentHistoryItemRefInFilter.set(!!provider?.currentHistoryItemRef && this.model.isCurrentRefInFilter());
    }
    render() {
        const { entries, hasMore, loading } = this.model;
        // Only show the empty state once the model has completed at least one load attempt.
        // While the model is still initializing (provider not yet set, no load attempted),
        // render a loading indicator to avoid a flash of "no history" on startup.
        if (!loading && entries.length === 0) {
            if (!this.model.hasAttemptedLoad) {
                return ((0, jsx_runtime_1.jsx)("div", { className: 'scm-history-loading', children: nls_1.nls.localizeByDefault('Loading') }));
            }
            return ((0, jsx_runtime_1.jsx)("div", { className: 'scm-history-empty', children: nls_1.nls.localize('theia/scm/noHistory', 'No source control history available.') }));
        }
        // Determine how many lanes are active for SVG width
        const maxLane = entries.reduce((max, e) => {
            const rowMax = Math.max(e.graphRow.lane, ...e.graphRow.edges.map(ed => Math.max(ed.fromLane, ed.toLane)));
            return Math.max(max, rowMax);
        }, 0);
        const svgWidth = (maxLane + 1) * LANE_WIDTH;
        const footer = loading
            ? () => (0, jsx_runtime_1.jsx)("div", { className: 'scm-history-loading', children: nls_1.nls.localizeByDefault('Loading') })
            : hasMore
                ? () => ((0, jsx_runtime_1.jsx)("div", { className: 'scm-history-load-more', onClick: this.handleLoadMore, role: 'button', tabIndex: 0, onKeyDown: this.handleLoadMoreKey, children: nls_1.nls.localizeByDefault('Load more') }))
                : undefined;
        return ((0, jsx_runtime_1.jsx)(react_virtuoso_1.Virtuoso, { ref: this.listRef, className: 'scm-history-graph-list', data: entries, itemContent: (idx, entry) => this.renderRow(entry, idx, svgWidth), endReached: hasMore && !loading && this.scmPreferences['scm.graph.pageOnScroll'] !== false ? this.handleEndReached : undefined, overscan: 500, components: footer ? { Footer: footer } : {}, style: { overflowX: 'hidden' } }));
    }
    renderRow(entry, idx, svgWidth) {
        const { item, graphRow } = entry;
        const isSelected = idx === this.selectedIndex;
        const isExpanded = this.expandedIds.has(item.id);
        const changes = this.expandedChanges.get(item.id);
        const isHead = entry.isCurrent;
        return ((0, jsx_runtime_1.jsxs)(React.Fragment, { children: [(0, jsx_runtime_1.jsxs)("div", { className: `scm-history-graph-row${isSelected ? ' selected' : ''}`, onClick: () => this.handleRowClick(idx, entry), onContextMenu: e => this.handleRowContextMenu(e, entry), onMouseEnter: e => this.handleRowMouseEnter(e, entry), children: [this.renderGraphSvg(graphRow, svgWidth, isHead), (0, jsx_runtime_1.jsxs)("div", { className: 'scm-history-graph-info', children: [(0, jsx_runtime_1.jsx)("span", { className: 'scm-history-subject', children: item.subject }), item.author && ((0, jsx_runtime_1.jsx)("span", { className: 'scm-history-author', children: item.author })), item.references && item.references.length > 0 && ((0, jsx_runtime_1.jsx)("span", { className: 'scm-history-badges scm-history-badges-right', children: this.renderRefBadges(item.references, entry) }))] })] }), isExpanded && this.renderChangesRows(item.id, svgWidth, graphRow, changes)] }, item.id));
    }
    get markdownRenderer() {
        this._markdownRenderer ||= this.markdownRendererFactory();
        return this._markdownRenderer;
    }
    /**
     * Prefers the hover content supplied by the provider, so that its own links and commands
     * (author `mailto:`, "Open Commit", remote actions) stay intact, and falls back to the hover
     * derived from the history item's fields for providers that supply none.
     */
    buildTooltip(entry) {
        const { tooltip } = entry.item;
        if (tooltip) {
            const provided = (0, scm_history_graph_tooltip_1.buildProviderTooltip)(tooltip, this.markdownRenderer, this.openerService, this.toDisposeOnHover);
            if (provided) {
                return provided;
            }
        }
        return (0, scm_history_graph_tooltip_1.buildHtmlTooltip)(entry, this.markdownRenderer, this.model.provider, {
            openCommit: () => this.openCommitFromTooltip(entry),
            copyCommitHash: () => this.clipboardService.writeText(entry.item.id),
        });
    }
    /** Selects the commit and expands its changes, closing the hover first. */
    openCommitFromTooltip(entry) {
        this.hoverService.cancelHover();
        const idx = this.model.entries.indexOf(entry);
        if (idx < 0) {
            return;
        }
        if (this.expandedIds.has(entry.item.id)) {
            this.selectedIndex = idx;
            this.update();
        }
        else {
            this.handleRowClick(idx, entry);
        }
    }
    renderChangesRows(itemId, svgWidth, graphRow, changes) {
        if (changes === 'loading' || changes === undefined) {
            return ((0, jsx_runtime_1.jsx)("div", { className: 'scm-history-changes-loading', children: nls_1.nls.localizeByDefault('Loading') }, `${itemId}-loading`));
        }
        if (changes.length === 0) {
            return ((0, jsx_runtime_1.jsx)("div", { className: 'scm-history-changes-empty', children: nls_1.nls.localize('theia/scm/noChanges', 'No changed files.') }, `${itemId}-empty`));
        }
        if (this.model.viewMode === 'tree') {
            const rootUri = this.scmService.selectedRepository?.provider.rootUri;
            const rows = (0, scm_history_graph_helpers_1.buildChangeTreeRows)(changes, rootUri, this.collapsedFolders.get(itemId) ?? EMPTY_FOLDER_SET);
            return ((0, jsx_runtime_1.jsx)(React.Fragment, { children: rows.map(row => row.type === 'folder'
                    ? this.renderChangeFolderRow(row, itemId, svgWidth, graphRow)
                    : this.renderChangeRow(row.change, row.index, itemId, svgWidth, graphRow, row.depth)) }, `${itemId}-changes`));
        }
        return ((0, jsx_runtime_1.jsx)(React.Fragment, { children: changes.map((change, ci) => this.renderChangeRow(change, ci, itemId, svgWidth, graphRow)) }, `${itemId}-changes`));
    }
    renderChangeFolderRow(row, itemId, svgWidth, graphRow) {
        const collapsed = this.isFolderCollapsed(itemId, row.path);
        return ((0, jsx_runtime_1.jsxs)("div", { className: 'scm-history-change-row scm-history-change-folder-row', onClick: e => this.handleFolderClick(e, itemId, row.path), role: 'treeitem', "aria-expanded": !collapsed, tabIndex: -1, children: [this.renderChangeRowSvg(graphRow, svgWidth), (0, jsx_runtime_1.jsxs)("div", { className: 'scm-history-change-info', style: indentStyle(row.depth), children: [(0, jsx_runtime_1.jsx)("span", { className: `codicon ${collapsed ? 'codicon-chevron-right' : 'codicon-chevron-down'} scm-history-change-twistie` }), (0, jsx_runtime_1.jsx)("span", { className: 'name scm-history-change-name', title: row.path, children: row.label })] })] }, `${itemId}-folder-${row.path}`));
    }
    isFolderCollapsed(itemId, path) {
        return !!this.collapsedFolders.get(itemId)?.has(path);
    }
    toggleFolder(itemId, path) {
        let collapsed = this.collapsedFolders.get(itemId);
        if (!collapsed) {
            collapsed = new Set();
            this.collapsedFolders.set(itemId, collapsed);
        }
        if (!collapsed.delete(path)) {
            collapsed.add(path);
        }
        this.update();
    }
    renderChangeRow(change, ci, itemId, svgWidth, graphRow, depth = 0) {
        const rootUri = this.scmService.selectedRepository?.provider.rootUri;
        const uri = change.modifiedUri ?? change.originalUri ?? change.uri;
        const relativePath = (0, scm_history_graph_helpers_1.getRepoRelativePath)(uri, rootUri);
        const fileName = (0, scm_history_graph_helpers_1.getFileName)(relativePath);
        // In tree mode the folder rows already carry the directory.
        const dirPath = this.model.viewMode === 'list' && relativePath.includes('/')
            ? relativePath.slice(0, relativePath.lastIndexOf('/'))
            : '';
        const status = (0, scm_history_graph_helpers_1.getChangeStatus)(change);
        const statusClass = status === 'A' ? 'added' : status === 'D' ? 'deleted' : status === 'R' ? 'renamed' : 'modified';
        const resourceUri = new uri_1.default(uri);
        const fileIcon = this.labelProvider.getIcon(resourceUri);
        const changeKey = `${itemId}-change-${ci}`;
        const isSelected = this.selectedChangeKey === changeKey;
        return ((0, jsx_runtime_1.jsxs)("div", { className: `scm-history-change-row${isSelected ? ' selected' : ''}`, onClick: e => this.handleChangeClick(e, change, changeKey), role: 'treeitem', tabIndex: -1, children: [this.renderChangeRowSvg(graphRow, svgWidth), (0, jsx_runtime_1.jsxs)("div", { className: 'scm-history-change-info', style: indentStyle(depth), children: [(0, jsx_runtime_1.jsx)("span", { className: `${fileIcon} file-icon scm-history-change-file-icon` }), (0, jsx_runtime_1.jsxs)("div", { className: 'scm-history-change-name-container', children: [(0, jsx_runtime_1.jsx)("span", { className: 'name scm-history-change-name', title: relativePath, children: fileName }), dirPath && (0, jsx_runtime_1.jsx)("span", { className: 'path scm-history-change-dir', children: dirPath })] }), (0, jsx_runtime_1.jsx)("span", { className: `scm-history-change-status ${statusClass}`, children: status })] })] }, changeKey));
    }
    openChange(change) {
        try {
            if (change.originalUri && change.modifiedUri) {
                const originalUri = new uri_1.default(change.originalUri);
                const modifiedUri = new uri_1.default(change.modifiedUri);
                const label = (0, scm_history_graph_helpers_1.getFileName)((0, scm_history_graph_helpers_1.getFilePath)(change.modifiedUri));
                (0, opener_service_1.open)(this.openerService, diff_uris_1.DiffUris.encode(originalUri, modifiedUri, label));
            }
            else if (change.modifiedUri) {
                (0, opener_service_1.open)(this.openerService, new uri_1.default(change.modifiedUri));
            }
            else if (change.originalUri) {
                (0, opener_service_1.open)(this.openerService, new uri_1.default(change.originalUri));
            }
            else {
                (0, opener_service_1.open)(this.openerService, new uri_1.default(change.uri));
            }
        }
        catch (err) {
            this.logger.error('Failed to open change', err);
        }
    }
    renderChangeRowSvg(graphRow, svgWidth) {
        const commitX = graphRow.lane * LANE_WIDTH + 11;
        const commitColor = (0, scm_history_graph_helpers_1.laneColor)(graphRow.color);
        const elements = [];
        let keyIdx = 0;
        for (const edge of graphRow.edges) {
            if (edge.type !== 'pass-through') {
                continue;
            }
            const x = edge.fromLane * LANE_WIDTH + 11;
            const color = (0, scm_history_graph_helpers_1.laneColor)(edge.color);
            elements.push((0, jsx_runtime_1.jsx)("path", { fill: 'none', strokeWidth: '1px', strokeLinecap: 'round', d: `M ${x} 0 V 22`, style: { stroke: color } }, `pass-${keyIdx++}`));
        }
        if (graphRow.hasContinuation) {
            elements.push((0, jsx_runtime_1.jsx)("path", { fill: 'none', strokeWidth: '1px', strokeLinecap: 'round', d: `M ${commitX} 0 V 22`, style: { stroke: commitColor } }, `commit-${keyIdx++}`));
        }
        return ((0, jsx_runtime_1.jsx)("svg", { className: 'scm-history-graph-svg', style: { height: `${ROW_HEIGHT}px`, width: `${svgWidth}px` }, children: elements }));
    }
    /**
     * Renders the SVG graph column for a commit row, matching VS Code's SVG structure:
     *
     * - Each lane is 22px wide; circle cx = lane * 22 + 11, cy = 11
     * - Pass-through lanes: full vertical line M x 0 V 22
     * - Commit lane: top segment (M commitX 0 V 11) + bottom segment (M commitX 11 V 22)
     * - HEAD/current commit (first entry): r=7 with inner dot, NO top segment
     * - Normal commit: r=5
     * - Branch-out edge: diagonal S-curve bezier from commit position (commitX, cy)
     *   sweeping down to the new lane at the bottom: M commitX cy C commitX 22 newX cy newX 22
     * - Merge-in edge: bezier from the source lane at the top curving into
     *   the commit position: M srcX 0 C srcX cy commitX cy commitX cy
     */
    renderGraphSvg(row, svgWidth, isHead) {
        const commitX = row.lane * LANE_WIDTH + 11;
        const cy = DOT_CY;
        const commitColor = (0, scm_history_graph_helpers_1.laneColor)(row.color);
        const elements = [];
        let keyIdx = 0;
        // Pass-through lines: straight vertical line through the full row height
        for (const edge of row.edges) {
            if (edge.type !== 'pass-through') {
                continue;
            }
            const x = edge.fromLane * LANE_WIDTH + 11;
            const color = (0, scm_history_graph_helpers_1.laneColor)(edge.color);
            elements.push((0, jsx_runtime_1.jsx)("path", { fill: 'none', strokeWidth: '1px', strokeLinecap: 'round', d: `M ${x} 0 V 22`, style: { stroke: color } }, `pass-${keyIdx++}`));
        }
        // Merge-in edges: source lane at top curves into the commit position (mid-row)
        for (const edge of row.edges) {
            if (edge.type !== 'merge-in') {
                continue;
            }
            const srcX = edge.fromLane * LANE_WIDTH + 11;
            const color = (0, scm_history_graph_helpers_1.laneColor)(edge.color);
            // Cubic bezier: start at (srcX, 0), control points pull both ends to mid-row,
            // end at commit position (commitX, cy)
            const d = `M ${srcX} 0 C ${srcX} ${cy}, ${commitX} ${cy}, ${commitX} ${cy}`;
            elements.push((0, jsx_runtime_1.jsx)("path", { fill: 'none', strokeWidth: '1px', strokeLinecap: 'round', d: d, style: { stroke: color } }, `merge-${keyIdx++}`));
        }
        // Commit lane lines — split at cy=11
        // Top segment: only drawn if there is an incoming line from above
        // (i.e. this commit was referenced as a parent by an earlier row).
        // It keeps the color inherited from the chain above, which may differ
        // from the commit's own (ref-based) color.
        if (row.hasTopLine) {
            elements.push((0, jsx_runtime_1.jsx)("path", { fill: 'none', strokeWidth: '1px', strokeLinecap: 'round', d: `M ${commitX} 0 V ${cy}`, style: { stroke: (0, scm_history_graph_helpers_1.laneColor)(row.topColor) } }, `top-${keyIdx++}`));
        }
        // Bottom segment: only drawn if the lane continues to a parent below
        if (row.hasContinuation) {
            elements.push((0, jsx_runtime_1.jsx)("path", { fill: 'none', strokeWidth: '1px', strokeLinecap: 'round', d: `M ${commitX} ${cy} V 22`, style: { stroke: commitColor } }, `bottom-${keyIdx++}`));
        }
        // Branch-out edges: commit position (mid-row) curves down to a new lane at bottom
        for (const edge of row.edges) {
            if (edge.type !== 'branch-out') {
                continue;
            }
            const dstX = edge.toLane * LANE_WIDTH + 11;
            const color = (0, scm_history_graph_helpers_1.laneColor)(edge.color);
            // Diagonal S-curve bezier: CP1 keeps x at srcX while y goes to bottom;
            // CP2 keeps y at cy while x reaches dstX — produces a smooth sweep
            // down-and-right (or left) from the commit circle to the target lane.
            const srcX = edge.fromLane * LANE_WIDTH + 11;
            const d = `M ${srcX} ${cy} C ${srcX} 22, ${dstX} ${cy}, ${dstX} 22`;
            elements.push((0, jsx_runtime_1.jsx)("path", { fill: 'none', strokeWidth: '1px', strokeLinecap: 'round', d: d, style: { stroke: color } }, `branch-${keyIdx++}`));
        }
        // Commit circle — drawn last so it renders on top of all lines
        if (isHead) {
            elements.push((0, jsx_runtime_1.jsx)("circle", { cx: commitX, cy: cy, r: 7, style: { strokeWidth: '2px', fill: commitColor } }, `circle-${keyIdx++}`));
            elements.push((0, jsx_runtime_1.jsx)("circle", { cx: commitX, cy: cy, r: 2, style: { strokeWidth: '4px', fill: 'var(--theia-editor-background)', stroke: 'var(--theia-editor-background)' } }, `inner-${keyIdx++}`));
        }
        else {
            elements.push((0, jsx_runtime_1.jsx)("circle", { cx: commitX, cy: cy, r: 5, style: { strokeWidth: '2px', fill: commitColor } }, `circle-${keyIdx++}`));
        }
        return ((0, jsx_runtime_1.jsx)("svg", { className: 'scm-history-graph-svg', style: { height: `${ROW_HEIGHT}px`, width: `${svgWidth}px` }, children: elements }));
    }
    renderRefBadges(refs, entry) {
        if (!refs || refs.length === 0) {
            return undefined;
        }
        const provider = this.model.provider;
        const visibleRefs = (0, scm_history_graph_helpers_1.filterRefsForBadges)(refs, provider, this.scmPreferences['scm.graph.badges'] ?? 'filter', this.model.historyItemRefFilter);
        if (visibleRefs.length === 0) {
            return undefined;
        }
        const laneColorValue = entry ? (0, scm_history_graph_helpers_1.laneColor)(entry.graphRow.color) : undefined;
        const deduplicated = (0, scm_history_graph_helpers_1.deduplicateRefs)(visibleRefs);
        const badgeForeground = 'var(--theia-scmGraph-historyItemRefForeground, var(--theia-badge-foreground))';
        const badges = [];
        for (const info of deduplicated) {
            if (badges.length >= 3) {
                break;
            }
            const { ref, hasBoth } = info;
            const isTag = (0, scm_history_graph_helpers_1.isTagRef)(ref);
            const isRemote = (0, scm_history_graph_helpers_1.isRemoteRef)(ref);
            const onContextMenu = entry ? (e) => this.handleRefBadgeContextMenu(e, entry, ref) : undefined;
            // Current/remote/base refs are colored by role, others by the row's lane color
            const { iconClass, colorIndex } = (0, scm_history_graph_helpers_1.getRefBadgePresentation)(ref, provider);
            const backgroundColor = colorIndex !== undefined ? (0, scm_history_graph_helpers_1.laneColor)(colorIndex) : laneColorValue;
            const style = backgroundColor
                ? { backgroundColor, color: badgeForeground }
                : {};
            badges.push(renderJsxRefBadge(ref, iconClass, !isTag, style, ref.id, onContextMenu));
            if (!isTag && !isRemote && hasBoth && badges.length < 3) {
                badges.push((0, jsx_runtime_1.jsx)("span", { className: 'scm-history-ref-badge scm-history-ref-badge-cloud', title: ref.description ?? ref.name, style: style, children: (0, jsx_runtime_1.jsx)("i", { className: 'codicon codicon-cloud scm-history-ref-icon' }) }, `${ref.id}-cloud`));
            }
        }
        return badges;
    }
    async loadChanges(entry) {
        const { item } = entry;
        const provider = this.model.provider;
        if (!provider) {
            this.expandedChanges.set(item.id, []);
            this.update();
            return;
        }
        this.expandedChanges.set(item.id, 'loading');
        this.update();
        const cts = new cancellation_1.CancellationTokenSource();
        this.loadChangesCts.set(item.id, cts);
        this.toDispose.push(cts);
        try {
            const parentId = item.parentIds?.[0];
            const changes = await provider.provideHistoryItemChanges(item.id, parentId, cts.token);
            if (!cts.token.isCancellationRequested) {
                this.expandedChanges.set(item.id, changes ?? []);
                this.update();
            }
        }
        catch (err) {
            if (!cts.token.isCancellationRequested) {
                this.logger.error('Failed to load changes', err);
                this.expandedChanges.set(item.id, []);
                this.update();
            }
        }
        finally {
            this.loadChangesCts.delete(item.id);
        }
    }
};
exports.ScmHistoryGraphWidget = ScmHistoryGraphWidget;
tslib_1.__decorate([
    (0, inversify_1.inject)(scm_history_graph_model_1.ScmHistoryGraphModel),
    tslib_1.__metadata("design:type", scm_history_graph_model_1.ScmHistoryGraphModel)
], ScmHistoryGraphWidget.prototype, "model", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(hover_service_1.HoverService),
    tslib_1.__metadata("design:type", hover_service_1.HoverService)
], ScmHistoryGraphWidget.prototype, "hoverService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(clipboard_service_1.ClipboardService),
    tslib_1.__metadata("design:type", Object)
], ScmHistoryGraphWidget.prototype, "clipboardService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(markdown_renderer_1.MarkdownRendererFactory),
    tslib_1.__metadata("design:type", Function)
], ScmHistoryGraphWidget.prototype, "markdownRendererFactory", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(scm_service_1.ScmService),
    tslib_1.__metadata("design:type", scm_service_1.ScmService)
], ScmHistoryGraphWidget.prototype, "scmService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(label_provider_1.LabelProvider),
    tslib_1.__metadata("design:type", label_provider_1.LabelProvider)
], ScmHistoryGraphWidget.prototype, "labelProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(context_menu_renderer_1.ContextMenuRenderer),
    tslib_1.__metadata("design:type", context_menu_renderer_1.ContextMenuRenderer)
], ScmHistoryGraphWidget.prototype, "contextMenuRenderer", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(opener_service_1.OpenerService),
    tslib_1.__metadata("design:type", Object)
], ScmHistoryGraphWidget.prototype, "openerService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(scm_context_key_service_1.ScmContextKeyService),
    tslib_1.__metadata("design:type", scm_context_key_service_1.ScmContextKeyService)
], ScmHistoryGraphWidget.prototype, "scmContextKeys", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(scm_preferences_1.ScmPreferences),
    tslib_1.__metadata("design:type", Object)
], ScmHistoryGraphWidget.prototype, "scmPreferences", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('scm:ScmHistoryGraphWidget'),
    tslib_1.__metadata("design:type", Object)
], ScmHistoryGraphWidget.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], ScmHistoryGraphWidget.prototype, "init", null);
exports.ScmHistoryGraphWidget = ScmHistoryGraphWidget = ScmHistoryGraphWidget_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__metadata("design:paramtypes", [])
], ScmHistoryGraphWidget);
//# sourceMappingURL=scm-history-graph-widget.js.map