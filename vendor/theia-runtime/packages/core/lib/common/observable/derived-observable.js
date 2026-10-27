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
// copied and modified from https://github.com/microsoft/vscode/blob/1.96.3/src/vs/base/common/observableInternal/derived.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.DerivedObservable = void 0;
const observable_base_1 = require("./observable-base");
/**
 * An observable that is derived from other observables.
 * Its value is only (re-)computed when absolutely needed.
 */
class DerivedObservable extends observable_base_1.BaseObservable {
    constructor(compute, options) {
        super();
        this.compute = compute;
        this.state = 0 /* DerivedObservable.State.Initial */;
        this.updateCount = 0;
        this.isComputing = false;
        this.dependencies = new Set();
        this.dependencyObserver = this.createDependencyObserver();
        this.isEqual = options?.isEqual ?? ((a, b) => a === b);
        this.createChangeSummary = options?.createChangeSummary;
        this.willHandleChange = options?.willHandleChange;
        this.changeSummary = this.createChangeSummary?.();
    }
    onLastObserverRemoved() {
        // We are not tracking changes anymore, thus we have to invalidate the cached value.
        this.state = 0 /* DerivedObservable.State.Initial */;
        this.value = undefined;
        for (const dependency of this.dependencies) {
            dependency.removeObserver(this.dependencyObserver);
        }
        this.dependencies.clear();
    }
    getValue() {
        if (this.isComputing) {
            throw new Error('Cyclic dependencies are not allowed');
        }
        if (this.observers.size === 0) {
            // Without observers, we don't know when to clean up stuff.
            // Thus, we don't cache anything to prevent memory leaks.
            let result;
            try {
                this.isComputing = true;
                result = observable_base_1.Observable.Accessor.runWithAccessor(() => this.compute({ changeSummary: this.createChangeSummary?.() }), dependency => this.watchDependency(dependency));
            }
            finally {
                this.isComputing = false;
                // Clear new dependencies.
                this.onLastObserverRemoved();
            }
            return result;
        }
        else {
            do {
                if (this.state === 1 /* DerivedObservable.State.DependenciesMightHaveChanged */) {
                    // Need to ask our depedencies if at least one of them has actually changed.
                    for (const dependency of this.dependencies) {
                        dependency.update(); // might call handleChange indirectly, which could make us stale
                        if (this.state === 2 /* DerivedObservable.State.Stale */) {
                            // The other dependencies will refresh on demand, so early break
                            break;
                        }
                    }
                }
                // If we are still not stale, we can assume to be up to date again.
                if (this.state === 1 /* DerivedObservable.State.DependenciesMightHaveChanged */) {
                    this.state = 3 /* DerivedObservable.State.UpToDate */;
                }
                if (this.state !== 3 /* DerivedObservable.State.UpToDate */) {
                    this.recompute();
                }
                // In case recomputation changed one of our dependencies, we need to recompute again.
            } while (this.state !== 3 /* DerivedObservable.State.UpToDate */);
            return this.value;
        }
    }
    recompute() {
        this.dependenciesToBeRemoved = this.dependencies;
        this.dependencies = new Set();
        const hadValue = this.state !== 0 /* DerivedObservable.State.Initial */;
        const oldValue = this.value;
        this.state = 3 /* DerivedObservable.State.UpToDate */;
        try {
            const { changeSummary } = this;
            this.changeSummary = this.createChangeSummary?.();
            this.isComputing = true;
            this.value = observable_base_1.Observable.Accessor.runWithAccessor(() => this.compute({ changeSummary }), dependency => this.watchDependency(dependency));
        }
        finally {
            this.isComputing = false;
            // We don't want our watched dependencies to think that they are no longer observed, even temporarily.
            // Thus, we only unsubscribe from dependencies that are definitely not watched anymore.
            for (const dependency of this.dependenciesToBeRemoved) {
                dependency.removeObserver(this.dependencyObserver);
            }
            this.dependenciesToBeRemoved = undefined;
        }
        const didChange = hadValue && !this.isEqual(oldValue, this.value);
        if (didChange) {
            for (const observer of this.observers) {
                observer.handleChange(this);
            }
        }
    }
    watchDependency(dependency) {
        if (!this.isComputing) {
            throw new Error('The accessor may only be called while the compute function is running');
        }
        // Subscribe before getting the value to enable caching.
        dependency.addObserver(this.dependencyObserver);
        // This might call handleChange indirectly, which could invalidate us.
        const value = dependency.getUntracked();
        // Which is why we only add the observable to the dependencies now.
        this.dependencies.add(dependency);
        this.dependenciesToBeRemoved?.delete(dependency);
        return value;
    }
    createDependencyObserver() {
        let inBeginUpdate = false;
        return {
            beginUpdate: () => {
                if (inBeginUpdate) {
                    throw new Error('Cyclic dependencies are not allowed');
                }
                inBeginUpdate = true;
                try {
                    this.updateCount++;
                    const propagateBeginUpdate = this.updateCount === 1;
                    if (this.state === 3 /* DerivedObservable.State.UpToDate */) {
                        this.state = 1 /* DerivedObservable.State.DependenciesMightHaveChanged */;
                        // If we propagate begin update, that will already signal a possible change.
                        if (!propagateBeginUpdate) {
                            for (const observer of this.observers) {
                                observer.handlePossibleChange(this);
                            }
                        }
                    }
                    if (propagateBeginUpdate) {
                        for (const observer of this.observers) {
                            observer.beginUpdate(this); // signals a possible change
                        }
                    }
                }
                finally {
                    inBeginUpdate = false;
                }
            },
            endUpdate: () => {
                this.updateCount--;
                if (this.updateCount === 0) {
                    // Calls to endUpdate can potentially change the observers list.
                    let observers = [...this.observers];
                    for (const observer of observers) {
                        observer.endUpdate(this);
                    }
                    if (this.removedObserversToCallEndUpdateOn) {
                        observers = [...this.removedObserversToCallEndUpdateOn];
                        this.removedObserversToCallEndUpdateOn = undefined;
                        for (const observer of observers) {
                            observer.endUpdate(this);
                        }
                    }
                }
                if (this.updateCount < 0) {
                    throw new Error('Unexpected update count: ' + this.updateCount);
                }
            },
            handlePossibleChange: (observable) => {
                // In all other states, observers already know that we might have changed.
                if (this.state === 3 /* DerivedObservable.State.UpToDate */ && this.dependencies.has(observable) && !this.dependenciesToBeRemoved?.has(observable)) {
                    this.state = 1 /* DerivedObservable.State.DependenciesMightHaveChanged */;
                    for (const observer of this.observers) {
                        observer.handlePossibleChange(this);
                    }
                }
            },
            handleChange: (observable, change) => {
                if (this.dependencies.has(observable) && !this.dependenciesToBeRemoved?.has(observable)) {
                    let shouldReact = true;
                    if (this.willHandleChange) {
                        try {
                            shouldReact = this.willHandleChange({
                                observable,
                                change,
                                isChangeOf: (o) => o === observable
                            }, this.changeSummary);
                        }
                        catch (e) {
                            console.error(e);
                        }
                    }
                    const wasUpToDate = this.state === 3 /* DerivedObservable.State.UpToDate */;
                    if (shouldReact && (this.state === 1 /* DerivedObservable.State.DependenciesMightHaveChanged */ || wasUpToDate)) {
                        this.state = 2 /* DerivedObservable.State.Stale */;
                        if (wasUpToDate) {
                            for (const observer of this.observers) {
                                observer.handlePossibleChange(this);
                            }
                        }
                    }
                }
            }
        };
    }
    addObserver(observer) {
        const shouldCallBeginUpdate = !this.observers.has(observer) && this.updateCount > 0;
        super.addObserver(observer);
        if (shouldCallBeginUpdate) {
            if (this.removedObserversToCallEndUpdateOn?.has(observer)) {
                this.removedObserversToCallEndUpdateOn.delete(observer);
            }
            else {
                observer.beginUpdate(this);
            }
        }
    }
    removeObserver(observer) {
        if (this.observers.has(observer) && this.updateCount > 0) {
            if (!this.removedObserversToCallEndUpdateOn) {
                this.removedObserversToCallEndUpdateOn = new Set();
            }
            this.removedObserversToCallEndUpdateOn.add(observer);
        }
        super.removeObserver(observer);
    }
}
exports.DerivedObservable = DerivedObservable;
(function (DerivedObservable) {
    function create(compute, options) {
        return new DerivedObservable(compute, options);
    }
    DerivedObservable.create = create;
})(DerivedObservable || (exports.DerivedObservable = DerivedObservable = {}));
//# sourceMappingURL=derived-observable.js.map