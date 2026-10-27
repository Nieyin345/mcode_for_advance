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
Object.defineProperty(exports, "__esModule", { value: true });
exports.MergeEditorSpacerZone = exports.MergeEditorActionZonePlaceholder = exports.MergeEditorActionZone = exports.MergeEditorViewZoneComputer = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const observable_1 = require("@theia/core/lib/common/observable");
const monaco = require("@theia/monaco-editor-core");
const merge_range_actions_1 = require("./merge-range-actions");
const diff_spacers_1 = require("./diff-spacers");
let MergeEditorViewZoneComputer = class MergeEditorViewZoneComputer {
    computeViewZones(mergeEditor) {
        const baseViewZones = [];
        const side1ViewZones = [];
        const side2ViewZones = [];
        const resultViewZones = [];
        const { model, shouldAlignResult, shouldAlignBase } = mergeEditor;
        for (const mergeRange of model.mergeRanges) {
            const { side1Pane, side2Pane, resultPane } = mergeEditor;
            const actions = this.newMergeRangeActions(mergeEditor, mergeRange);
            let resultActionZoneHeight = this.getActionZoneMinHeight(resultPane);
            if (actions.hasSideActions || (shouldAlignResult && actions.hasResultActions)) {
                let actionZoneHeight = Math.max(this.getActionZoneMinHeight(side1Pane), this.getActionZoneMinHeight(side2Pane));
                if (shouldAlignResult) {
                    resultActionZoneHeight = actionZoneHeight = Math.max(actionZoneHeight, resultActionZoneHeight);
                }
                side1ViewZones.push(this.newActionZone(side1Pane, actions.side1ActionsObservable, mergeRange.side1Range.startLineNumber - 1, actionZoneHeight));
                side2ViewZones.push(this.newActionZone(side2Pane, actions.side2ActionsObservable, mergeRange.side2Range.startLineNumber - 1, actionZoneHeight));
                if (shouldAlignBase) {
                    baseViewZones.push(this.newActionZonePlaceholder(mergeRange.baseRange.startLineNumber - 1, actionZoneHeight));
                }
            }
            if (actions.hasResultActions) {
                resultViewZones.push(this.newActionZone(resultPane, actions.resultActionsObservable, model.getLineRangeInResult(mergeRange).startLineNumber - 1, resultActionZoneHeight));
            }
            else if (shouldAlignResult && actions.hasSideActions) {
                resultViewZones.push(this.newActionZonePlaceholder(model.getLineRangeInResult(mergeRange).startLineNumber - 1, resultActionZoneHeight));
            }
        }
        const baseLineCount = model.baseDocument.lineCount;
        const multiDiffSpacers = [];
        multiDiffSpacers.push(this.diffSpacerService.computeDiffSpacers(model.side1Changes, baseLineCount));
        multiDiffSpacers.push(this.diffSpacerService.computeDiffSpacers(model.side2Changes, baseLineCount));
        if (shouldAlignResult) {
            multiDiffSpacers.push(this.diffSpacerService.computeDiffSpacers(model.resultChanges, baseLineCount));
        }
        const combinedMultiDiffSpacers = this.diffSpacerService.combineMultiDiffSpacers(multiDiffSpacers);
        if (shouldAlignBase) {
            this.createSpacerZones(combinedMultiDiffSpacers.originalSpacers, baseViewZones);
        }
        const { modifiedSides } = shouldAlignBase ? combinedMultiDiffSpacers : this.diffSpacerService.excludeOriginalSide(combinedMultiDiffSpacers);
        this.createSpacerZones(modifiedSides[0].modifiedSpacers, side1ViewZones);
        this.createSpacerZones(modifiedSides[1].modifiedSpacers, side2ViewZones);
        if (shouldAlignResult) {
            this.createSpacerZones(modifiedSides[2].modifiedSpacers, resultViewZones);
        }
        return { baseViewZones, side1ViewZones, side2ViewZones, resultViewZones };
    }
    createSpacerZones(spacers, viewZones) {
        const lineNumbers = Object.keys(spacers).map(Number); // note: spacers is a sparse array
        for (const lineNumber of lineNumbers) {
            const heightInLines = spacers[lineNumber];
            if (heightInLines) {
                viewZones.push(this.newSpacerZone(lineNumber - 1, heightInLines));
            }
        }
    }
    newMergeRangeActions(mergeEditor, mergeRange) {
        return new merge_range_actions_1.MergeRangeActions(mergeEditor, mergeRange);
    }
    getActionZoneMinHeight(pane) {
        return pane.editor.getControl().getOption(monaco.editor.EditorOption.lineHeight);
    }
    newActionZone(pane, actions, afterLineNumber, heightInPx) {
        return new MergeEditorActionZone(pane, actions, afterLineNumber, heightInPx);
    }
    newActionZonePlaceholder(afterLineNumber, heightInPx) {
        return new MergeEditorActionZonePlaceholder(afterLineNumber, heightInPx);
    }
    newSpacerZone(afterLineNumber, heightInLines) {
        return new MergeEditorSpacerZone(afterLineNumber, heightInLines);
    }
};
exports.MergeEditorViewZoneComputer = MergeEditorViewZoneComputer;
tslib_1.__decorate([
    (0, inversify_1.inject)(diff_spacers_1.DiffSpacerService),
    tslib_1.__metadata("design:type", diff_spacers_1.DiffSpacerService)
], MergeEditorViewZoneComputer.prototype, "diffSpacerService", void 0);
exports.MergeEditorViewZoneComputer = MergeEditorViewZoneComputer = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MergeEditorViewZoneComputer);
class MergeEditorActionZone {
    static { this.counter = 0; }
    constructor(pane, actionsObservable, afterLineNumber, heightInPx) {
        this.pane = pane;
        this.actionsObservable = actionsObservable;
        this.afterLineNumber = afterLineNumber;
        this.heightInPx = heightInPx;
    }
    create(ctx) {
        const overlayWidgetNode = document.createElement('div');
        overlayWidgetNode.className = 'action-zone';
        ctx.createViewZone({
            domNode: document.createElement('div'),
            afterLineNumber: this.afterLineNumber + 1, // + 1, since line numbers in Monaco are 1-based
            heightInPx: this.heightInPx,
            onComputedHeight: height => overlayWidgetNode.style.height = `${height}px`,
            onDomNodeTop: top => overlayWidgetNode.style.top = `${top}px`
        });
        const editor = this.pane.editor.getControl();
        const setLeftPosition = () => overlayWidgetNode.style.left = editor.getLayoutInfo().contentLeft + 'px';
        setLeftPosition();
        ctx.register(editor.onDidLayoutChange(setLeftPosition));
        const overlayWidgetId = `mergeEditorActionZone${MergeEditorActionZone.counter++}`;
        const overlayWidget = {
            getId: () => overlayWidgetId,
            getDomNode: () => overlayWidgetNode,
            // eslint-disable-next-line no-null/no-null
            getPosition: () => null
        };
        editor.addOverlayWidget(overlayWidget);
        ctx.register(core_1.Disposable.create(() => {
            editor.removeOverlayWidget(overlayWidget);
        }));
        const actionContainer = document.createElement('div');
        actionContainer.className = 'codelens-decoration';
        overlayWidgetNode.appendChild(actionContainer);
        ctx.register(observable_1.Autorun.create(() => this.renderActions(actionContainer, this.actionsObservable.get())));
    }
    ;
    renderActions(parent, actions) {
        const children = [];
        let isFirst = true;
        for (const action of actions) {
            if (isFirst) {
                isFirst = false;
            }
            else {
                const actionSeparator = document.createElement('span');
                actionSeparator.append('\u00a0|\u00a0');
                children.push(actionSeparator);
            }
            const title = this.getActionTitle(action);
            if (action.run) {
                const actionLink = document.createElement('a');
                actionLink.role = 'button';
                actionLink.onclick = () => action.run();
                if (action.tooltip) {
                    actionLink.title = action.tooltip;
                }
                actionLink.append(title);
                children.push(actionLink);
            }
            else {
                const actionLabel = document.createElement('span');
                if (action.tooltip) {
                    actionLabel.title = action.tooltip;
                }
                actionLabel.append(title);
                children.push(actionLabel);
            }
        }
        parent.innerText = ''; // reset children
        parent.append(...children);
    }
    getActionTitle(action) {
        return action.text;
    }
}
exports.MergeEditorActionZone = MergeEditorActionZone;
class MergeEditorActionZonePlaceholder {
    constructor(afterLineNumber, heightInPx) {
        this.afterLineNumber = afterLineNumber;
        this.heightInPx = heightInPx;
    }
    create(ctx) {
        const domNode = document.createElement('div');
        domNode.className = 'action-zone-placeholder';
        ctx.createViewZone({
            afterLineNumber: this.afterLineNumber + 1, // + 1, since line numbers in Monaco are 1-based
            heightInPx: this.heightInPx,
            domNode
        });
    }
}
exports.MergeEditorActionZonePlaceholder = MergeEditorActionZonePlaceholder;
class MergeEditorSpacerZone {
    constructor(afterLineNumber, heightInLines) {
        this.afterLineNumber = afterLineNumber;
        this.heightInLines = heightInLines;
    }
    create(ctx) {
        const domNode = document.createElement('div');
        domNode.className = 'diagonal-fill';
        ctx.createViewZone({
            afterLineNumber: this.afterLineNumber + 1, // + 1, since line numbers in Monaco are 1-based
            heightInLines: this.heightInLines,
            domNode
        });
    }
}
exports.MergeEditorSpacerZone = MergeEditorSpacerZone;
//# sourceMappingURL=merge-editor-view-zones.js.map