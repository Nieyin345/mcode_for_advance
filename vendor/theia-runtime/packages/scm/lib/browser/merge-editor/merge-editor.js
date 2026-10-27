"use strict";
// *****************************************************************************
// Copyright (C) 2025 1C-Soft LLC and others.
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
var MergeEditorSettings_1, MergeEditorOpenHandler_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.MergeEditorOpenHandler = exports.MergeEditor = exports.MergeEditorSettings = exports.MergeEditorLayoutMode = exports.MergeEditorUri = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const browser_1 = require("@theia/core/lib/browser");
const observable_1 = require("@theia/core/lib/common/observable");
const merge_editor_model_1 = require("./model/merge-editor-model");
const merge_editor_panes_1 = require("./view/merge-editor-panes");
const merge_editor_view_zones_1 = require("./view/merge-editor-view-zones");
const merge_editor_scroll_sync_1 = require("./view/merge-editor-scroll-sync");
var MergeEditorUri;
(function (MergeEditorUri) {
    const SCHEME = 'merge-editor';
    function isMergeEditorUri(uri) {
        return uri.scheme === SCHEME;
    }
    MergeEditorUri.isMergeEditorUri = isMergeEditorUri;
    function encode({ baseUri, side1Uri, side2Uri, resultUri }) {
        return new core_1.URI().withScheme(SCHEME).withQuery(JSON.stringify([baseUri.toString(), side1Uri.toString(), side2Uri.toString(), resultUri.toString()]));
    }
    MergeEditorUri.encode = encode;
    function decode(uri) {
        if (uri.scheme !== SCHEME) {
            throw new Error(`The URI must have scheme ${SCHEME}. The URI was: ${uri}`);
        }
        const mergeUris = JSON.parse(uri.query);
        if (!Array.isArray(mergeUris) || !mergeUris.every(mergeUri => typeof mergeUri === 'string')) {
            throw new Error(`The URI ${uri} is not a valid URI for scheme ${SCHEME}`);
        }
        return {
            baseUri: new core_1.URI(mergeUris[0]),
            side1Uri: new core_1.URI(mergeUris[1]),
            side2Uri: new core_1.URI(mergeUris[2]),
            resultUri: new core_1.URI(mergeUris[3])
        };
    }
    MergeEditorUri.decode = decode;
})(MergeEditorUri || (exports.MergeEditorUri = MergeEditorUri = {}));
var MergeEditorLayoutMode;
(function (MergeEditorLayoutMode) {
    MergeEditorLayoutMode.DEFAULT = { kind: 'mixed', showBase: true, showBaseAtTop: false };
})(MergeEditorLayoutMode || (exports.MergeEditorLayoutMode = MergeEditorLayoutMode = {}));
let MergeEditorSettings = class MergeEditorSettings {
    constructor() {
        this.layoutMode = MergeEditorLayoutMode.DEFAULT;
    }
    static { MergeEditorSettings_1 = this; }
    static { this.LAYOUT_MODE = 'mergeEditor/layoutMode'; }
    async load() {
        await Promise.allSettled([
            this.storageService.getData(MergeEditorSettings_1.LAYOUT_MODE, this.layoutMode).then(layoutMode => this.layoutMode = layoutMode),
        ]);
    }
    async save() {
        await Promise.allSettled([
            this.storageService.setData(MergeEditorSettings_1.LAYOUT_MODE, this.layoutMode),
        ]);
    }
};
exports.MergeEditorSettings = MergeEditorSettings;
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.StorageService),
    tslib_1.__metadata("design:type", Object)
], MergeEditorSettings.prototype, "storageService", void 0);
exports.MergeEditorSettings = MergeEditorSettings = MergeEditorSettings_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MergeEditorSettings);
let MergeEditor = class MergeEditor extends browser_1.BaseWidget {
    constructor() {
        super(...arguments);
        this.visibilityObservable = observable_1.SettableObservable.create(true);
        this.currentPaneObservable = observable_1.SettableObservable.create(undefined);
        this.layoutModeObservable = observable_1.SettableObservable.create(MergeEditorLayoutMode.DEFAULT, {
            isEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b)
        });
        this.currentMergeRangeObservable = this.createCurrentMergeRangeObservable();
        this.selectionInBaseObservable = this.createSelectionInBaseObservable();
        this.layoutInitialized = false;
    }
    init() {
        this.addClass('theia-merge-editor');
        const { baseUri, side1Uri, side2Uri, resultUri } = this;
        this.id = MergeEditorUri.encode({ baseUri, side1Uri, side2Uri, resultUri }).toString();
        const setLabels = () => {
            this.title.label = core_1.nls.localizeByDefault('Merging: {0}', this.labelProvider.getName(resultUri));
            this.title.iconClass = this.labelProvider.getIcon(resultUri) + ' file-icon';
            this.resultPane.header.description = this.labelProvider.getLongName(resultUri);
        };
        setLabels();
        this.toDispose.push(this.labelProvider.onDidChange(event => {
            if (event.affects(resultUri)) {
                setLabels();
            }
        }));
        this.title.caption = resultUri.path.fsPath();
        this.title.closable = true;
        this.basePane.header.title.label = core_1.nls.localizeByDefault('Base');
        this.side1Pane.header.title.label = core_1.nls.localizeByDefault('Input 1');
        this.side2Pane.header.title.label = core_1.nls.localizeByDefault('Input 2');
        this.resultPane.header.title.label = core_1.nls.localizeByDefault('Result');
        this.panes.forEach(pane => pane.mergeEditor = this);
        const layout = this.layout = new browser_1.PanelLayout();
        this.verticalSplitPanel = new browser_1.SplitPanel({
            spacing: 1, // --theia-border-width
            orientation: 'vertical'
        });
        layout.addWidget(this.verticalSplitPanel);
        this.horizontalSplitPanel = new browser_1.SplitPanel({
            spacing: 1, // --theia-border-width
            orientation: 'horizontal'
        });
        this.verticalSplitPanel.addWidget(this.horizontalSplitPanel);
        this.layoutMode = this.settings.layoutMode;
        this.toDispose.push(this.scrollSync = this.createScrollSynchronizer());
        this.initCurrentPaneTracker();
    }
    createScrollSynchronizer() {
        return new merge_editor_scroll_sync_1.MergeEditorScrollSync(this);
    }
    initCurrentPaneTracker() {
        const focusTracker = new browser_1.FocusTracker();
        this.toDispose.push(focusTracker);
        focusTracker.currentChanged.connect((_, { oldValue, newValue }) => {
            oldValue?.removeClass('focused');
            newValue?.addClass('focused');
            this.currentPaneObservable.set(newValue || undefined);
        });
        this.panes.forEach(pane => focusTracker.add(pane));
    }
    ensureLayoutInitialized() {
        if (!this.layoutInitialized) {
            this.layoutInitialized = true;
            this.doInitializeLayout();
            this.onLayoutInitialized();
        }
    }
    doInitializeLayout() {
        this.toDispose.push(observable_1.Autorun.create(({ isFirstRun }) => {
            const { layoutMode } = this;
            observable_1.Observable.noAutoTracking(() => {
                const scrollState = this.scrollSync.storeScrollState();
                const { currentPane } = this;
                this.applyLayoutMode(layoutMode);
                const pane = currentPane?.isVisible ? currentPane : this.resultPane;
                pane.editor.focus();
                this.scrollSync.restoreScrollState(scrollState);
                if (!isFirstRun) {
                    this.settings.layoutMode = layoutMode;
                }
            });
        }));
        let storedState;
        let viewZones;
        this.toDispose.push(core_1.Disposable.create(() => viewZones?.dispose()));
        this.toDispose.push(observable_1.Autorun.create(() => {
            if (this.isShown) {
                let scrollState;
                observable_1.Observable.noAutoTracking(() => {
                    scrollState = storedState?.scrollState ?? this.scrollSync.storeScrollState();
                    viewZones?.dispose();
                });
                viewZones = this.createViewZones();
                observable_1.Observable.noAutoTracking(() => {
                    if (storedState) {
                        const { currentPane } = storedState;
                        storedState = undefined;
                        const pane = currentPane ?? this.resultPane;
                        pane.editor.focus();
                    }
                    this.scrollSync.restoreScrollState(scrollState);
                });
            }
            else {
                observable_1.Observable.noAutoTracking(() => {
                    storedState = {
                        scrollState: this.scrollSync.storeScrollState(),
                        currentPane: this.currentPane
                    };
                    viewZones?.dispose();
                    viewZones = undefined;
                });
            }
        }));
    }
    onLayoutInitialized() {
        const shouldGoToInitialMergeRange = () => {
            const { cursorPosition } = this.currentPane ?? this.resultPane;
            return cursorPosition.line === 0 && cursorPosition.character === 0;
        };
        if (shouldGoToInitialMergeRange()) {
            this.model.onInitialized.then(() => {
                if (!this.isDisposed && shouldGoToInitialMergeRange()) {
                    this.goToFirstMergeRange(mergeRange => !this.model.isMergeRangeHandled(mergeRange));
                }
            });
        }
    }
    onResize(msg) {
        super.onResize(msg);
        if (msg.width >= 0 && msg.height >= 0) {
            // Don't try to initialize layout until the merge editor itself is positioned.
            // Otherwise, SplitPanel.setRelativeSizes might not work properly when initializing layout.
            this.ensureLayoutInitialized();
        }
    }
    get isShown() {
        return this.visibilityObservable.get();
    }
    get currentPane() {
        return this.currentPaneObservable.get();
    }
    createCurrentMergeRangeObservable() {
        return observable_1.DerivedObservable.create(() => {
            const { currentPane } = this;
            if (!currentPane) {
                return undefined;
            }
            const { cursorLine } = currentPane;
            return this.model.mergeRanges.find(mergeRange => {
                const lineRange = currentPane.getLineRangeForMergeRange(mergeRange);
                return lineRange.isEmpty ? lineRange.startLineNumber === cursorLine : lineRange.containsLine(cursorLine);
            });
        });
    }
    get currentMergeRange() {
        return this.currentMergeRangeObservable.get();
    }
    createSelectionInBaseObservable() {
        return observable_1.DerivedObservable.create(() => {
            const { currentPane } = this;
            return currentPane?.selection?.map(range => {
                if (currentPane === this.side1Pane) {
                    return this.model.translateSideRangeToBase(range, 1);
                }
                if (currentPane === this.side2Pane) {
                    return this.model.translateSideRangeToBase(range, 2);
                }
                if (currentPane === this.resultPane) {
                    return this.model.translateResultRangeToBase(range);
                }
                return range;
            });
        });
    }
    get selectionInBase() {
        return this.selectionInBaseObservable.get();
    }
    get panes() {
        return [this.basePane, this.side1Pane, this.side2Pane, this.resultPane];
    }
    get baseUri() {
        return this.basePane.editor.uri;
    }
    get side1Uri() {
        return this.side1Pane.editor.uri;
    }
    get side1Title() {
        return this.side1Pane.header.title.label;
    }
    get side2Uri() {
        return this.side2Pane.editor.uri;
    }
    get side2Title() {
        return this.side2Pane.header.title.label;
    }
    get resultUri() {
        return this.resultPane.editor.uri;
    }
    storeState() {
        const getSideState = ({ header }) => ({
            title: header.title.label,
            description: header.description,
            detail: header.detail
        });
        return {
            layoutMode: this.layoutMode,
            side1State: getSideState(this.side1Pane),
            side2State: getSideState(this.side2Pane)
        };
    }
    restoreState(state) {
        const { layoutMode, side1State, side2State } = state;
        if (layoutMode) {
            this.layoutMode = layoutMode;
        }
        const restoreSideState = ({ header }, { title, description, detail }) => {
            if (title) {
                header.title.label = title;
            }
            if (description) {
                header.description = description;
            }
            if (detail) {
                header.detail = detail;
            }
        };
        if (side1State) {
            restoreSideState(this.side1Pane, side1State);
        }
        if (side2State) {
            restoreSideState(this.side2Pane, side2State);
        }
    }
    get saveable() {
        return this.resultPane.editor.document;
    }
    getResourceUri() {
        return this.resultUri;
    }
    createMoveToUri(resourceUri) {
        const { baseUri, side1Uri, side2Uri, resultUri } = this;
        return MergeEditorUri.encode({ baseUri, side1Uri, side2Uri, resultUri: resultUri.withPath(resourceUri.path) });
    }
    getTrackableWidgets() {
        return this.panes.map(pane => pane.editorWidget);
    }
    goToFirstMergeRange(predicate = () => true) {
        const firstMergeRange = this.model.mergeRanges.find(mergeRange => predicate(mergeRange));
        if (firstMergeRange) {
            const pane = this.currentPane ?? this.resultPane;
            pane.goToMergeRange(firstMergeRange);
        }
    }
    goToNextMergeRange(predicate = () => true) {
        const pane = this.currentPane ?? this.resultPane;
        const { cursorLine } = pane;
        const isAfterCursorLine = (mergeRange) => pane.getLineRangeForMergeRange(mergeRange).startLineNumber > cursorLine;
        const nextMergeRange = this.model.mergeRanges.find(mergeRange => predicate(mergeRange) && isAfterCursorLine(mergeRange)) ||
            this.model.mergeRanges.find(mergeRange => predicate(mergeRange));
        if (nextMergeRange) {
            pane.goToMergeRange(nextMergeRange);
        }
    }
    goToPreviousMergeRange(predicate = () => true) {
        const pane = this.currentPane ?? this.resultPane;
        const { cursorLine } = pane;
        const isBeforeCursorLine = (mergeRange) => {
            const lineRange = pane.getLineRangeForMergeRange(mergeRange);
            return lineRange.isEmpty ? lineRange.startLineNumber < cursorLine : lineRange.endLineNumberExclusive <= cursorLine;
        };
        const previousMergeRange = core_1.ArrayUtils.findLast(this.model.mergeRanges, mergeRange => predicate(mergeRange) && isBeforeCursorLine(mergeRange)) ||
            core_1.ArrayUtils.findLast(this.model.mergeRanges, mergeRange => predicate(mergeRange));
        if (previousMergeRange) {
            pane.goToMergeRange(previousMergeRange);
        }
    }
    get layoutMode() {
        return this.layoutModeObservable.get();
    }
    set layoutMode(value) {
        this.layoutModeObservable.set(value);
    }
    get layoutKind() {
        return this.layoutMode.kind;
    }
    set layoutKind(kind) {
        this.layoutMode = {
            ...this.layoutMode,
            kind
        };
    }
    get isShowingBase() {
        return this.layoutMode.showBase;
    }
    get isShowingBaseAtTop() {
        const { layoutMode } = this;
        return layoutMode.showBase && layoutMode.showBaseAtTop;
    }
    toggleShowBase() {
        const { layoutMode } = this;
        this.layoutMode = {
            ...layoutMode,
            showBase: !layoutMode.showBase
        };
    }
    toggleShowBaseTop() {
        const { layoutMode } = this;
        const isToggled = layoutMode.showBase && layoutMode.showBaseAtTop;
        this.layoutMode = {
            ...layoutMode,
            showBaseAtTop: true,
            showBase: !isToggled,
        };
    }
    toggleShowBaseCenter() {
        const { layoutMode } = this;
        const isToggled = layoutMode.showBase && !layoutMode.showBaseAtTop;
        this.layoutMode = {
            ...layoutMode,
            showBaseAtTop: false,
            showBase: !isToggled,
        };
    }
    get shouldAlignResult() {
        return this.layoutKind === 'columns';
    }
    get shouldAlignBase() {
        const { layoutMode } = this;
        return layoutMode.kind === 'mixed' && layoutMode.showBase && !layoutMode.showBaseAtTop;
    }
    applyLayoutMode(layoutMode) {
        const oldVerticalSplitWidgets = [...this.verticalSplitPanel.widgets];
        if (!layoutMode.showBase) {
            // eslint-disable-next-line no-null/no-null
            this.basePane.parent = null;
        }
        this.horizontalSplitPanel.insertWidget(0, this.side1Pane);
        this.horizontalSplitPanel.insertWidget(2, this.side2Pane);
        let horizontalSplitRatio = [50, 50];
        let verticalSplitRatio;
        if (layoutMode.kind === 'columns') {
            horizontalSplitRatio = [33, 34, 33];
            verticalSplitRatio = [100];
            this.horizontalSplitPanel.insertWidget(1, this.resultPane);
            if (layoutMode.showBase) {
                verticalSplitRatio = [30, 70];
                this.verticalSplitPanel.insertWidget(0, this.basePane);
            }
        }
        else {
            verticalSplitRatio = [45, 55];
            if (layoutMode.showBase) {
                if (layoutMode.showBaseAtTop) {
                    verticalSplitRatio = [30, 33, 37];
                    this.verticalSplitPanel.insertWidget(0, this.basePane);
                }
                else {
                    horizontalSplitRatio = [33, 34, 33];
                    this.horizontalSplitPanel.insertWidget(1, this.basePane);
                }
            }
            this.verticalSplitPanel.insertWidget(2, this.resultPane);
        }
        this.horizontalSplitPanel.setRelativeSizes(horizontalSplitRatio);
        // Keep the existing vertical split ratio if the layout mode change has not affected the vertical split layout.
        if (!core_1.ArrayUtils.equals(oldVerticalSplitWidgets, this.verticalSplitPanel.widgets)) {
            this.verticalSplitPanel.setRelativeSizes(verticalSplitRatio);
        }
    }
    createViewZones() {
        const { baseViewZones, side1ViewZones, side2ViewZones, resultViewZones } = this.viewZoneComputer.computeViewZones(this);
        const toDispose = new core_1.DisposableCollection();
        const addViewZones = (pane, viewZones) => {
            const editor = pane.editor.getControl();
            const viewZoneIds = [];
            toDispose.push(core_1.Disposable.create(() => {
                editor.changeViewZones(accessor => {
                    for (const viewZoneId of viewZoneIds) {
                        accessor.removeZone(viewZoneId);
                    }
                });
            }));
            editor.changeViewZones(accessor => {
                const ctx = {
                    createViewZone: viewZone => viewZoneIds.push(accessor.addZone(viewZone)),
                    register: disposable => toDispose.push(disposable)
                };
                for (const viewZone of viewZones) {
                    viewZone.create(ctx);
                }
            });
        };
        addViewZones(this.basePane, baseViewZones);
        addViewZones(this.side1Pane, side1ViewZones);
        addViewZones(this.side2Pane, side2ViewZones);
        addViewZones(this.resultPane, resultViewZones);
        return toDispose;
    }
    onBeforeHide(msg) {
        this.visibilityObservable.set(false);
    }
    onAfterShow(msg) {
        this.visibilityObservable.set(true);
    }
    onActivateRequest(msg) {
        super.onActivateRequest(msg);
        const { currentPane } = this;
        if (currentPane) {
            currentPane.editor.focus();
        }
        else {
            this.resultPane.editor.focus();
        }
    }
};
exports.MergeEditor = MergeEditor;
tslib_1.__decorate([
    (0, inversify_1.inject)(merge_editor_model_1.MergeEditorModel),
    tslib_1.__metadata("design:type", merge_editor_model_1.MergeEditorModel)
], MergeEditor.prototype, "model", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(merge_editor_panes_1.MergeEditorBasePane),
    tslib_1.__metadata("design:type", merge_editor_panes_1.MergeEditorBasePane)
], MergeEditor.prototype, "basePane", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(merge_editor_panes_1.MergeEditorSide1Pane),
    tslib_1.__metadata("design:type", merge_editor_panes_1.MergeEditorSide1Pane)
], MergeEditor.prototype, "side1Pane", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(merge_editor_panes_1.MergeEditorSide2Pane),
    tslib_1.__metadata("design:type", merge_editor_panes_1.MergeEditorSide2Pane)
], MergeEditor.prototype, "side2Pane", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(merge_editor_panes_1.MergeEditorResultPane),
    tslib_1.__metadata("design:type", merge_editor_panes_1.MergeEditorResultPane)
], MergeEditor.prototype, "resultPane", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(merge_editor_view_zones_1.MergeEditorViewZoneComputer),
    tslib_1.__metadata("design:type", merge_editor_view_zones_1.MergeEditorViewZoneComputer)
], MergeEditor.prototype, "viewZoneComputer", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(MergeEditorSettings),
    tslib_1.__metadata("design:type", MergeEditorSettings)
], MergeEditor.prototype, "settings", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.LabelProvider),
    tslib_1.__metadata("design:type", browser_1.LabelProvider)
], MergeEditor.prototype, "labelProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], MergeEditor.prototype, "init", null);
exports.MergeEditor = MergeEditor = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MergeEditor);
let MergeEditorOpenHandler = class MergeEditorOpenHandler extends browser_1.NavigatableWidgetOpenHandler {
    constructor() {
        super(...arguments);
        this.id = MergeEditorOpenHandler_1.ID;
        this.label = core_1.nls.localizeByDefault('Merge Editor');
    }
    static { MergeEditorOpenHandler_1 = this; }
    static { this.ID = 'merge-editor-opener'; }
    canHandle(uri, options) {
        return MergeEditorUri.isMergeEditorUri(uri) ? 1000 : 0;
    }
    open(uri, options) {
        return super.open(uri, options);
    }
    async getOrCreateWidget(uri, options) {
        const widget = await super.getOrCreateWidget(uri, options);
        if (options?.widgetState) {
            widget.restoreState(options.widgetState);
        }
        return widget;
    }
};
exports.MergeEditorOpenHandler = MergeEditorOpenHandler;
exports.MergeEditorOpenHandler = MergeEditorOpenHandler = MergeEditorOpenHandler_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MergeEditorOpenHandler);
//# sourceMappingURL=merge-editor.js.map