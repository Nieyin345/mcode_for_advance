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
// copied and modified from https://github.com/microsoft/vscode/blob/1.96.3/src/vs/base/common/observableInternal/utils.ts,
// https://github.com/microsoft/vscode/blob/1.96.3/src/vs/base/common/observableInternal/utilsCancellation.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.ObservableUtils = void 0;
const cancellation_1 = require("../cancellation");
const disposable_1 = require("../disposable");
const derived_observable_1 = require("./derived-observable");
const autorun_1 = require("./autorun");
var ObservableUtils;
(function (ObservableUtils) {
    /**
     * Creates an {@link Autorun.create autorun} that passes a collector for disposable objects to the {@link run} function.
     * The collected disposables are disposed before the next run or when the autorun is disposed.
     */
    function autorunWithDisposables(run, options) {
        let toDispose = undefined;
        return new class extends autorun_1.Autorun {
            dispose() {
                super.dispose();
                toDispose?.dispose();
            }
        }(({ autorun, isFirstRun, changeSummary }) => {
            toDispose?.dispose();
            toDispose = new disposable_1.DisposableCollection();
            run({ toDispose, autorun, isFirstRun, changeSummary });
        }, options);
    }
    ObservableUtils.autorunWithDisposables = autorunWithDisposables;
    function derivedObservableWithCache(compute, options) {
        let value = undefined;
        return new derived_observable_1.DerivedObservable(({ changeSummary }) => {
            value = compute({ lastValue: value, changeSummary });
            return value;
        }, options);
    }
    ObservableUtils.derivedObservableWithCache = derivedObservableWithCache;
    function waitForState(observable, predicate, isError, cancellationToken) {
        if (!predicate) {
            predicate = state => !!state;
        }
        return new Promise((resolve, reject) => {
            const stateObservable = derived_observable_1.DerivedObservable.create(() => {
                const state = observable.get();
                return {
                    isFinished: predicate(state),
                    error: isError ? isError(state) : false,
                    state
                };
            });
            const autorun_ = autorun_1.Autorun.create(({ autorun }) => {
                const { isFinished, error, state } = stateObservable.get();
                if (isFinished || error) {
                    autorun.dispose();
                    if (error) {
                        reject(error === true ? state : error);
                    }
                    else {
                        resolve(state);
                    }
                }
            });
            if (cancellationToken) {
                const subscription = cancellationToken.onCancellationRequested(() => {
                    autorun_.dispose();
                    subscription.dispose();
                    reject(new cancellation_1.CancellationError());
                });
                if (cancellationToken.isCancellationRequested) {
                    autorun_.dispose();
                    subscription.dispose();
                    reject(new cancellation_1.CancellationError());
                }
            }
        });
    }
    ObservableUtils.waitForState = waitForState;
})(ObservableUtils || (exports.ObservableUtils = ObservableUtils = {}));
//# sourceMappingURL=observable-utils.js.map