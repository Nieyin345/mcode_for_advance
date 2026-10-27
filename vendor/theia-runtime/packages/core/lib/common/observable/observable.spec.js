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
// copied and modified from https://github.com/microsoft/vscode/blob/1.96.3/src/vs/base/test/common/observable.test.ts
Object.defineProperty(exports, "__esModule", { value: true });
const chai_1 = require("chai");
const disposable_1 = require("../disposable");
const observable_base_1 = require("./observable-base");
const settable_observable_1 = require("./settable-observable");
const derived_observable_1 = require("./derived-observable");
const observable_signal_1 = require("./observable-signal");
const autorun_1 = require("./autorun");
describe('Observables', () => {
    let disposables;
    beforeEach(() => disposables = new disposable_1.DisposableCollection());
    afterEach(() => disposables.dispose());
    // Read these tests to understand how to use observables.
    describe('Tutorial', () => {
        it('settable observable & autorun', () => {
            const log = new Log();
            // This creates an observable with an initial value that can later be changed with the `set` method.
            const myObservable = settable_observable_1.SettableObservable.create(0);
            // This creates an autorun. The autorun has to be disposed!
            disposables.push(autorun_1.Autorun.create(() => {
                // Observables are automatically added to the tracked dependencies of the autorun as they are accessed with `get`.
                log.log(`myAutorun.run(myObservable: ${myObservable.get()})`);
                // Now that all dependencies are tracked, the autorun is re-run whenever any of the dependencies change.
            }));
            // The autorun runs immediately.
            (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal(['myAutorun.run(myObservable: 0)']);
            myObservable.set(1);
            // The autorun runs again, because its dependency changed.
            (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal(['myAutorun.run(myObservable: 1)']);
            myObservable.set(1);
            // The autorun didn't run, because the observable was set to the same value (no change).
            (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal([]);
            // An update scope can be used to batch autorun runs.
            observable_base_1.Observable.update(() => {
                myObservable.set(2);
                (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal([]); // The autorun didn't run, even though its dependency changed!
                myObservable.set(3);
                (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal([]);
            });
            // The autorun re-runs only at the end of the update scope.
            // Note that the autorun didn't see the intermediate value `2`!
            (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal(['myAutorun.run(myObservable: 3)']);
        });
        it('derived observable & autorun', () => {
            const log = new Log();
            const observable1 = settable_observable_1.SettableObservable.create(0);
            const observable2 = settable_observable_1.SettableObservable.create(0);
            // This creates an observable that is derived from other observables.
            const myDerived = derived_observable_1.DerivedObservable.create(() => {
                // Dependencies are automatically tracked as they are accessed with `get`.
                const value1 = observable1.get();
                const value2 = observable2.get();
                const sum = value1 + value2;
                log.log(`myDerived.recompute: ${value1} + ${value2} = ${sum}`);
                return sum;
            });
            // This creates an autorun that reacts to changes of the derived observable.
            disposables.push(autorun_1.Autorun.create(() => {
                log.log(`myAutorun(myDerived: ${myDerived.get()})`);
            }));
            // The autorun runs immediately...
            (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal([
                'myDerived.recompute: 0 + 0 = 0',
                'myAutorun(myDerived: 0)',
            ]);
            observable1.set(1);
            // ...and on changes...
            (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal([
                'myDerived.recompute: 1 + 0 = 1',
                'myAutorun(myDerived: 1)',
            ]);
            observable2.set(1);
            // ...of the derived observable.
            (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal([
                'myDerived.recompute: 1 + 1 = 2',
                'myAutorun(myDerived: 2)',
            ]);
            // Multiple observables can be updated in a batch.
            observable_base_1.Observable.update(() => {
                observable1.set(5);
                (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal([]);
                observable2.set(5);
                (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal([]);
            });
            // The autorun re-runs only at the end of the update scope.
            // Derived observables are only recomputed on demand.
            (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal([
                'myDerived.recompute: 5 + 5 = 10',
                'myAutorun(myDerived: 10)',
            ]);
            observable_base_1.Observable.update(() => {
                observable1.set(6);
                (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal([]);
                observable2.set(4);
                (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal([]);
            });
            // The autorun didn't run, because its dependency changed from 10 to 10 (no change).
            (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal(['myDerived.recompute: 6 + 4 = 10']);
        });
        it('derived observable: get within update scope', () => {
            const log = new Log();
            const observable1 = settable_observable_1.SettableObservable.create(0);
            const observable2 = settable_observable_1.SettableObservable.create(0);
            const myDerived = derived_observable_1.DerivedObservable.create(() => {
                const value1 = observable1.get();
                const value2 = observable2.get();
                const sum = value1 + value2;
                log.log(`myDerived.recompute: ${value1} + ${value2} = ${sum}`);
                return sum;
            });
            disposables.push(autorun_1.Autorun.create(() => {
                log.log(`myAutorun(myDerived: ${myDerived.get()})`);
            }));
            // The autorun runs immediately.
            (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal([
                'myDerived.recompute: 0 + 0 = 0',
                'myAutorun(myDerived: 0)',
            ]);
            observable_base_1.Observable.update(() => {
                observable1.set(-10);
                (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal([]);
                myDerived.get(); // This forces a (sync) recomputation of the current value!
                (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal(['myDerived.recompute: -10 + 0 = -10']);
                // This means that, even within an update scope, all observable values you get are up-to-date.
                // It might just cause additional (potentially unneeded) recomputations.
                observable2.set(10);
                (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal([]);
            });
            // The autorun runs again, because its dependency changed from 0 to -10 and then back to 0.
            (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal([
                'myDerived.recompute: -10 + 10 = 0',
                'myAutorun(myDerived: 0)',
            ]);
        });
        it('derived observable: get without observers', () => {
            const log = new Log();
            const observable1 = settable_observable_1.SettableObservable.create(0);
            const computed1 = derived_observable_1.DerivedObservable.create(() => {
                const value1 = observable1.get();
                const result = value1 % 3;
                log.log(`recompute1: ${value1} % 3 = ${result}`);
                return result;
            });
            const computed2 = derived_observable_1.DerivedObservable.create(() => {
                const value1 = computed1.get();
                const result = value1 * 2;
                log.log(`recompute2: ${value1} * 2 = ${result}`);
                return result;
            });
            const computed3 = derived_observable_1.DerivedObservable.create(() => {
                const value1 = computed1.get();
                const result = value1 * 3;
                log.log(`recompute3: ${value1} * 3 = ${result}`);
                return result;
            });
            const computedSum = derived_observable_1.DerivedObservable.create(() => {
                const value1 = computed2.get();
                const value2 = computed3.get();
                const result = value1 + value2;
                log.log(`recompute4: ${value1} + ${value2} = ${result}`);
                return result;
            });
            (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal([]);
            observable1.set(1);
            // Derived observables are only recomputed on demand.
            (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal([]);
            log.log(`value: ${computedSum.get()}`);
            (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal([
                'recompute1: 1 % 3 = 1',
                'recompute2: 1 * 2 = 2',
                'recompute3: 1 * 3 = 3',
                'recompute4: 2 + 3 = 5',
                'value: 5',
            ]);
            log.log(`value: ${computedSum.get()}`);
            // Because there are no observers, the derived observable values are not cached (!) but recomputed from scratch.
            (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal([
                'recompute1: 1 % 3 = 1',
                'recompute2: 1 * 2 = 2',
                'recompute3: 1 * 3 = 3',
                'recompute4: 2 + 3 = 5',
                'value: 5',
            ]);
            // keepObserved can be used to keep the cache alive.
            const disposable = observable_base_1.Observable.keepObserved(computedSum);
            log.log(`value: ${computedSum.get()}`);
            (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal([
                'recompute1: 1 % 3 = 1',
                'recompute2: 1 * 2 = 2',
                'recompute3: 1 * 3 = 3',
                'recompute4: 2 + 3 = 5',
                'value: 5',
            ]);
            log.log(`value: ${computedSum.get()}`);
            // Tada, no recomputations!
            (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal([
                'value: 5',
            ]);
            observable1.set(2);
            // keepObserved does not force derived observables to be recomputed.
            (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal([]);
            log.log(`value: ${computedSum.get()}`);
            // Derived observables are only recomputed on demand...
            (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal([
                'recompute1: 2 % 3 = 2',
                'recompute2: 2 * 2 = 4',
                'recompute3: 2 * 3 = 6',
                'recompute4: 4 + 6 = 10',
                'value: 10',
            ]);
            log.log(`value: ${computedSum.get()}`);
            // ...and then cached again.
            (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal(['value: 10']);
            // Don't forget to dispose the disposable returned by keepObserved!
            disposable.dispose();
            log.log(`value: ${computedSum.get()}`);
            // The cache is disabled again.
            (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal([
                'recompute1: 2 % 3 = 2',
                'recompute2: 2 * 2 = 4',
                'recompute3: 2 * 3 = 6',
                'recompute4: 4 + 6 = 10',
                'value: 10',
            ]);
            log.log(`value: ${computedSum.get()}`);
            (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal([
                'recompute1: 2 % 3 = 2',
                'recompute2: 2 * 2 = 4',
                'recompute3: 2 * 3 = 6',
                'recompute4: 4 + 6 = 10',
                'value: 10',
            ]);
        });
        it('autorun that receives change information of signals', () => {
            const log = new Log();
            // A signal is an observable without a value.
            // However, it can ship change information when it is triggered.
            const signal = observable_signal_1.ObservableSignal.create();
            disposables.push(autorun_1.Autorun.create(({ changeSummary }) => {
                signal.get(); // This makes sure the signal is tracked as a dependency of the autorun.
                log.log('msgs: ' + changeSummary.msgs.join(', '));
            }, {
                // A change summary can be used to collect the reported changes.
                createChangeSummary: () => ({ msgs: [] }),
                willHandleChange: (context, changeSummary) => {
                    if (context.isChangeOf(signal)) {
                        changeSummary.msgs.push(context.change.msg);
                    }
                    return true;
                },
            }));
            signal.trigger({ msg: 'foobar' });
            // An update scope can be used to batch triggering signals.
            // No change information is lost!
            observable_base_1.Observable.update(() => {
                signal.trigger({ msg: 'hello' });
                signal.trigger({ msg: 'world' });
            });
            (0, chai_1.expect)(log.getAndClearEntries()).to.be.deep.equal([
                'msgs: ',
                'msgs: foobar',
                'msgs: hello, world'
            ]);
        });
    });
});
class Log {
    constructor() {
        this.entries = [];
    }
    log(message) {
        this.entries.push(message);
    }
    getAndClearEntries() {
        const entries = [...this.entries];
        this.entries.length = 0;
        return entries;
    }
}
//# sourceMappingURL=observable.spec.js.map