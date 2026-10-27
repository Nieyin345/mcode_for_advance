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
// copied and modified from https://github.com/microsoft/vscode/blob/1.96.3/src/vs/base/common/observableInternal/base.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseObservable = exports.AbstractObservable = exports.Observable = void 0;
const disposable_1 = require("../disposable");
var Observable;
(function (Observable) {
    let Accessor;
    (function (Accessor) {
        let current;
        function getCurrent() {
            return current;
        }
        Accessor.getCurrent = getCurrent;
        function runWithAccessor(run, accessor) {
            const previous = current;
            current = accessor;
            try {
                return run();
            }
            finally {
                current = previous;
            }
        }
        Accessor.runWithAccessor = runWithAccessor;
    })(Accessor = Observable.Accessor || (Observable.Accessor = {}));
    /**
     * Runs the given function within an invocation context where calling {@link Observable.get} without passing the `accessor` argument
     * will have the same effect as calling {@link Observable.getUntracked}.
     */
    function noAutoTracking(run) {
        const accessor = Accessor.getCurrent();
        return Accessor.runWithAccessor(() => run(accessor), undefined);
    }
    Observable.noAutoTracking = noAutoTracking;
    /**
     * Represents an update scope in which multiple observables can be updated in a batch.
     */
    class UpdateScope {
        constructor() {
            this.list = [];
        }
        /**
         * This method is called by the framework and should not typically be called by ordinary clients.
         *
         * Calls {@link Observer.beginUpdate} immediately, and {@link Observer.endUpdate} when this update scope gets disposed.
         *
         * Note that this method may be called while the update scope is being disposed.
         */
        push(observer, observable) {
            if (this.list) {
                this.list.push({ observer, observable });
                observer.beginUpdate(observable);
            }
            else {
                throw new Error('Update scope has been disposed');
            }
        }
        dispose() {
            const list = this.list;
            if (list) {
                // Note: `this.push` may be called from `observer.endUpdate` directly or indirectly. This code supports it.
                UpdateScope.runWithUpdateScope(() => {
                    for (let i = 0; i < list.length; i++) {
                        const { observer, observable } = list[i];
                        observer.endUpdate(observable);
                    }
                }, this);
            }
            this.list = undefined;
        }
    }
    Observable.UpdateScope = UpdateScope;
    (function (UpdateScope) {
        let current;
        function getCurrent() {
            return current;
        }
        UpdateScope.getCurrent = getCurrent;
        function runWithUpdateScope(run, updateScope) {
            const previous = current;
            current = updateScope;
            try {
                return run();
            }
            finally {
                current = previous;
            }
        }
        UpdateScope.runWithUpdateScope = runWithUpdateScope;
    })(UpdateScope = Observable.UpdateScope || (Observable.UpdateScope = {}));
    /**
     * Runs the given function within an update scope in which multiple observables can be updated in a batch.
     */
    function update(run, updateScope = UpdateScope.getCurrent()) {
        const ownsUpdateScope = !updateScope;
        if (!updateScope) {
            updateScope = new UpdateScope();
        }
        try {
            return UpdateScope.runWithUpdateScope(() => run(updateScope), updateScope);
        }
        finally {
            if (ownsUpdateScope) {
                updateScope.dispose();
            }
        }
    }
    Observable.update = update;
    /**
     * Makes sure that the given observable is being observed until the returned disposable is disposed,
     * after which there is no longer a guarantee that the observable is being observed by at least one observer.
     *
     * This function can help keep the cache of a derived observable alive even when there might be no other observers.
     */
    function keepObserved(observable) {
        const observer = {
            beginUpdate: () => { },
            endUpdate: () => { },
            handlePossibleChange: () => { },
            handleChange: () => { }
        };
        observable.addObserver(observer);
        return disposable_1.Disposable.create(() => {
            observable.removeObserver(observer);
        });
    }
    Observable.keepObserved = keepObserved;
})(Observable || (exports.Observable = Observable = {}));
class AbstractObservable {
    get(accessor = Observable.Accessor.getCurrent()) {
        return accessor ? accessor(this) : this.getValue();
    }
    getUntracked() {
        return this.getValue();
    }
    update() {
        this.getValue();
    }
}
exports.AbstractObservable = AbstractObservable;
class BaseObservable extends AbstractObservable {
    constructor() {
        super(...arguments);
        this.observers = new Set();
    }
    addObserver(observer) {
        const isFirst = this.observers.size === 0;
        this.observers.add(observer);
        if (isFirst) {
            this.onFirstObserverAdded();
        }
    }
    removeObserver(observer) {
        const deleted = this.observers.delete(observer);
        if (deleted && this.observers.size === 0) {
            this.onLastObserverRemoved();
        }
    }
    onFirstObserverAdded() { }
    onLastObserverRemoved() { }
}
exports.BaseObservable = BaseObservable;
//# sourceMappingURL=observable-base.js.map