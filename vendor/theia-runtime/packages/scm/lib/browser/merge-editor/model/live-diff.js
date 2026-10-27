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
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// copied and modified from https://github.com/microsoft/vscode/blob/1.96.3/src/vs/workbench/contrib/mergeEditor/browser/model/textModelDiffs.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.LiveDiff = void 0;
const core_1 = require("@theia/core");
const observable_1 = require("@theia/core/lib/common/observable");
const range_mapping_1 = require("./range-mapping");
const line_range_1 = require("./line-range");
class LiveDiff {
    constructor(originalDocument, modifiedDocument, diffComputer) {
        this.originalDocument = originalDocument;
        this.modifiedDocument = modifiedDocument;
        this.diffComputer = diffComputer;
        this.recomputeCount = 0;
        this.stateObservable = observable_1.SettableObservable.create(0 /* LiveDiffState.Initializing */);
        this.changesObservable = observable_1.SettableObservable.create([]);
        this.toDispose = new core_1.DisposableCollection();
        const recomputeSignal = observable_1.ObservableSignal.create();
        this.toDispose.push(observable_1.Autorun.create(() => {
            recomputeSignal.get();
            this.recompute();
        }));
        this.toDispose.push(originalDocument.onDidChangeContent(() => recomputeSignal.trigger()));
        this.toDispose.push(modifiedDocument.onDidChangeContent(() => recomputeSignal.trigger()));
    }
    dispose() {
        this.toDispose.dispose();
    }
    get state() {
        return this.stateObservable.get();
    }
    get changes() {
        return this.changesObservable.get();
    }
    recompute() {
        const recomputeCount = ++this.recomputeCount;
        if (this.stateObservable.getUntracked() !== 0 /* LiveDiffState.Initializing */) { // untracked to avoid an infinite change loop in the autorun
            this.stateObservable.set(2 /* LiveDiffState.Updating */);
        }
        this.diffComputer.computeDiff(new core_1.URI(this.originalDocument.uri), new core_1.URI(this.modifiedDocument.uri)).then(diff => {
            if (this.toDispose.disposed || this.originalDocument.isDisposed() || this.modifiedDocument.isDisposed()) {
                return;
            }
            if (recomputeCount !== this.recomputeCount) {
                // There is a newer recompute call
                return;
            }
            const toLineRange = (r) => new line_range_1.LineRange(r.start, r.end - r.start);
            const changes = diff?.changes.map(change => new range_mapping_1.DetailedLineRangeMapping(toLineRange(change.left), this.originalDocument, toLineRange(change.right), this.modifiedDocument, change.innerChanges?.map(innerChange => new range_mapping_1.RangeMapping(innerChange.left, innerChange.right))));
            observable_1.Observable.update(() => {
                if (changes) {
                    this.stateObservable.set(1 /* LiveDiffState.UpToDate */);
                    this.changesObservable.set(changes);
                }
                else {
                    this.stateObservable.set(3 /* LiveDiffState.Error */);
                }
            });
        });
    }
}
exports.LiveDiff = LiveDiff;
//# sourceMappingURL=live-diff.js.map