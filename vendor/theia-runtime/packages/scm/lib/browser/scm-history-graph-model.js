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
exports.ScmHistoryGraphModel = exports.ScmHistoryGraphModelProvider = exports.PAGE_SIZE = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const disposable_1 = require("@theia/core/lib/common/disposable");
const event_1 = require("@theia/core/lib/common/event");
const cancellation_1 = require("@theia/core/lib/common/cancellation");
const scm_service_1 = require("./scm-service");
const scm_history_graph_lanes_1 = require("./scm-history-graph-lanes");
const core_1 = require("@theia/core");
const scm_history_graph_helpers_1 = require("./scm-history-graph-helpers");
const scm_preferences_1 = require("../common/scm-preferences");
exports.PAGE_SIZE = 50;
exports.ScmHistoryGraphModelProvider = Symbol('ScmHistoryGraphModelProvider');
let ScmHistoryGraphModel = class ScmHistoryGraphModel {
    constructor() {
        this.toDispose = new disposable_1.DisposableCollection();
        this.toDisposeOnProviderChange = new disposable_1.DisposableCollection();
        this._entries = [];
        this._hasMore = false;
        this._loading = false;
        this._hasAttemptedLoad = false;
        this._viewMode = 'list';
        this.onDidChangeEmitter = new event_1.Emitter();
        this.onDidChange = this.onDidChangeEmitter.event;
        this.onDidRequestRevealEmitter = new event_1.Emitter();
        /** Fired with the index of an entry the view should scroll to and select. */
        this.onDidRequestReveal = this.onDidRequestRevealEmitter.event;
        this.cancelSource = new cancellation_1.CancellationTokenSource();
    }
    init() {
        this.toDispose.pushAll([
            disposable_1.Disposable.create(() => this.toDisposeOnProviderChange.dispose()),
            this.onDidChangeEmitter,
            this.onDidRequestRevealEmitter,
            this.scmService.onDidChangeSelectedRepository(() => this.refresh()),
            this.scmPreferences.onPreferenceChanged(e => {
                if (e.preferenceName === 'scm.graph.pageSize') {
                    this.reload();
                }
            }),
        ]);
        this.refresh();
    }
    dispose() {
        this.cancelSource.cancel();
        this.toDispose.dispose();
    }
    get provider() {
        return this._provider;
    }
    /** The explicitly picked ref ids filtering the graph, or `undefined` in auto mode. */
    get historyItemRefFilter() {
        return this._historyItemRefFilter;
    }
    /** How the changes of an expanded history item are laid out. */
    get viewMode() {
        return this._viewMode;
    }
    /**
     * Switches how the changes of an expanded history item are laid out. This
     * only affects rendering, so the loaded history is kept as is.
     */
    setViewMode(viewMode) {
        if (this._viewMode === viewMode) {
            return;
        }
        this._viewMode = viewMode;
        this.onDidChangeEmitter.fire();
    }
    /**
     * Sets the ref ids to filter the graph by (`undefined` returns to auto
     * mode) and reloads the graph.
     */
    setHistoryItemRefFilter(refIds) {
        this._historyItemRefFilter = refIds && refIds.length > 0 ? [...refIds] : undefined;
        this.reload();
    }
    /**
     * Whether the current history item ref is part of the graph's filter.
     * Always true in auto mode, which includes the current ref.
     */
    isCurrentRefInFilter() {
        if (!this._historyItemRefFilter) {
            return true;
        }
        const currentId = this._provider?.currentHistoryItemRef?.id;
        return currentId !== undefined && this._historyItemRefFilter.includes(currentId);
    }
    get entries() {
        return this._entries;
    }
    get hasMore() {
        return this._hasMore;
    }
    get loading() {
        return this._loading;
    }
    /**
     * Returns true once the model has completed at least one load attempt
     * (regardless of whether history items were found). This is used by
     * the widget to distinguish "still initializing" from "no history".
     */
    get hasAttemptedLoad() {
        return this._hasAttemptedLoad;
    }
    refresh() {
        this.toDisposeOnProviderChange.dispose();
        const repo = this.scmService.selectedRepository;
        const hp = repo?.provider.historyProvider;
        if (hp !== this._provider) {
            // The repository changed — a filter picked for the old provider does not apply.
            this._historyItemRefFilter = undefined;
        }
        this._provider = hp;
        if (this._provider) {
            this.toDisposeOnProviderChange.push(this._provider.onDidChangeCurrentHistoryItemRefs(() => this.refresh()));
            this.toDisposeOnProviderChange.push(this._provider.onDidChangeHistoryItemRefs(e => {
                this.pruneHistoryItemRefFilter(e.removed);
                this.refresh();
            }));
        }
        else if (repo) {
            // historyProvider is not yet available; listen for provider changes
            // so that refresh() is retried when historyProvider becomes available.
            this.toDisposeOnProviderChange.push(repo.provider.onDidChange(() => this.refresh()));
        }
        this.reload();
    }
    /**
     * Drops refs that no longer exist from the explicit filter, so that
     * deleting or renaming a filtered ref does not leave the graph stuck
     * requesting history for it. When the last filtered ref is removed,
     * the filter falls back to auto mode.
     */
    pruneHistoryItemRefFilter(removed) {
        if (!this._historyItemRefFilter || removed.length === 0) {
            return;
        }
        const removedIds = new Set(removed.map(ref => ref.id));
        const remaining = this._historyItemRefFilter.filter(id => !removedIds.has(id));
        if (remaining.length !== this._historyItemRefFilter.length) {
            this._historyItemRefFilter = remaining.length > 0 ? remaining : undefined;
        }
    }
    /** Clears the loaded entries and loads the first page again from the current provider. */
    reload() {
        this.cancelSource.cancel();
        this.cancelSource = new cancellation_1.CancellationTokenSource();
        this._entries = [];
        this._hasMore = false;
        this.loadPage();
    }
    /**
     * Locates the commit the current history item ref points at, loading
     * further pages while it is outside the loaded range, and asks the view to
     * reveal it. Returns its index, or `undefined` when there is no current
     * history item ref or the commit is not part of the graph (e.g. the ref is
     * excluded by the filter).
     */
    async revealCurrentHistoryItem() {
        let index = this.indexOfCurrentHistoryItem();
        while (index === undefined && this._hasMore) {
            const loadedBefore = this._entries.length;
            await this.loadMore();
            if (this._entries.length === loadedBefore) {
                // The page added nothing new; paging further cannot find the item.
                break;
            }
            index = this.indexOfCurrentHistoryItem();
        }
        if (index !== undefined) {
            this.onDidRequestRevealEmitter.fire(index);
        }
        return index;
    }
    indexOfCurrentHistoryItem() {
        const index = this._entries.findIndex(entry => entry.isCurrent);
        return index === -1 ? undefined : index;
    }
    async loadMore() {
        if (this._loading || !this._hasMore) {
            return;
        }
        await this.loadPage();
    }
    async loadPage() {
        if (!this._provider) {
            this._entries = [];
            this._hasMore = false;
            this._loading = false;
            this._hasAttemptedLoad = true;
            this.onDidChangeEmitter.fire();
            return;
        }
        this._loading = true;
        this.onDidChangeEmitter.fire();
        const token = this.cancelSource.token;
        try {
            const pageSize = this.pageSize;
            const historyItemRefs = this.getCurrentHistoryItemRefs();
            const options = {
                skip: this._entries.length,
                limit: pageSize,
                historyItemRefs: historyItemRefs.length > 0 ? historyItemRefs : undefined,
            };
            const items = await this._provider.provideHistoryItems(options, token);
            if (token.isCancellationRequested) {
                return;
            }
            const fetchedItems = items ?? [];
            this._hasMore = fetchedItems.length >= pageSize;
            // Filter out any items already loaded so the graph does not show duplicates.
            const existingIds = new Set(this._entries.map(e => e.item.id));
            const newItems = fetchedItems.filter(i => !existingIds.has(i.id));
            const allItems = [...this._entries.map(e => e.item), ...newItems];
            const graphRows = (0, scm_history_graph_lanes_1.computeGraphRows)(allItems.map(i => ({
                id: i.id,
                parentIds: i.parentIds,
                colorIndex: this.resolveColorIndex(i),
            })));
            const currentRevision = this._provider.currentHistoryItemRef?.revision;
            this._entries = allItems.map((item, idx) => ({
                item,
                graphRow: graphRows[idx],
                isCurrent: currentRevision !== undefined && item.id === currentRevision,
            }));
        }
        catch (err) {
            if (!token.isCancellationRequested) {
                this.logger.error('Failed to load history', err);
            }
        }
        finally {
            if (!token.isCancellationRequested) {
                this._loading = false;
                this._hasAttemptedLoad = true;
                this.onDidChangeEmitter.fire();
            }
        }
    }
    /** The configured page size (`scm.graph.pageSize`). */
    get pageSize() {
        return this.scmPreferences['scm.graph.pageSize'] ?? exports.PAGE_SIZE;
    }
    /**
     * Resolves the ref-based color index of an item from its references,
     * preferring current (0) over remote (1) over base (2). Refs excluded by
     * an explicit filter get no role color, mirroring VS Code's color map.
     */
    resolveColorIndex(item) {
        let result;
        for (const ref of item.references ?? []) {
            if (this._historyItemRefFilter && !this._historyItemRefFilter.includes(ref.id)) {
                continue;
            }
            const index = (0, scm_history_graph_helpers_1.getRefColorIndex)(ref, this._provider);
            if (index !== undefined && (result === undefined || index < result)) {
                result = index;
            }
        }
        return result;
    }
    /**
     * Returns the refs to pass to `provideHistoryItems`: the explicitly picked
     * ref ids when a filter is active, otherwise (auto mode) the revisions of
     * the current branch ref, its remote tracking ref, and the merge-base ref.
     * Providers walk history starting from these refs.
     */
    getCurrentHistoryItemRefs() {
        if (this._historyItemRefFilter) {
            return [...this._historyItemRefFilter];
        }
        if (!this._provider) {
            return [];
        }
        const refs = [];
        if (this._provider.currentHistoryItemRef) {
            refs.push(this._provider.currentHistoryItemRef.revision ?? this._provider.currentHistoryItemRef.id);
        }
        if (this._provider.currentHistoryItemRemoteRef) {
            refs.push(this._provider.currentHistoryItemRemoteRef.revision ?? this._provider.currentHistoryItemRemoteRef.id);
        }
        if (this._provider.currentHistoryItemBaseRef) {
            refs.push(this._provider.currentHistoryItemBaseRef.revision ?? this._provider.currentHistoryItemBaseRef.id);
        }
        return refs;
    }
};
exports.ScmHistoryGraphModel = ScmHistoryGraphModel;
tslib_1.__decorate([
    (0, inversify_1.inject)(scm_service_1.ScmService),
    tslib_1.__metadata("design:type", scm_service_1.ScmService)
], ScmHistoryGraphModel.prototype, "scmService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(scm_preferences_1.ScmPreferences),
    tslib_1.__metadata("design:type", Object)
], ScmHistoryGraphModel.prototype, "scmPreferences", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('scm:ScmHistoryGraphModel'),
    tslib_1.__metadata("design:type", Object)
], ScmHistoryGraphModel.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], ScmHistoryGraphModel.prototype, "init", null);
exports.ScmHistoryGraphModel = ScmHistoryGraphModel = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], ScmHistoryGraphModel);
//# sourceMappingURL=scm-history-graph-model.js.map