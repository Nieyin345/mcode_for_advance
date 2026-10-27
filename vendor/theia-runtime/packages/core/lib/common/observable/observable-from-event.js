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
// copied and modified from https://github.com/microsoft/vscode/blob/1.96.3/src/vs/base/common/observableInternal/utils.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.ObservableSignalFromEvent = exports.ObservableFromEvent = void 0;
const observable_base_1 = require("./observable-base");
class ObservableFromEvent extends observable_base_1.BaseObservable {
    constructor(event, compute, options) {
        super();
        this.event = event;
        this.compute = compute;
        this.isEqual = options?.isEqual ?? ((a, b) => a === b);
        this.getUpdateScope = options?.getUpdateScope ?? observable_base_1.Observable.UpdateScope.getCurrent;
    }
    handleEvent(e) {
        const hadValue = this.hasValue();
        const oldValue = this.value;
        this.value = this.compute(e);
        const didChange = hadValue && !this.isEqual(oldValue, this.value);
        if (didChange) {
            observable_base_1.Observable.update(scope => {
                for (const observer of this.observers) {
                    scope.push(observer, this);
                    observer.handleChange(this);
                }
            }, this.getUpdateScope());
        }
    }
    ;
    onFirstObserverAdded() {
        this.subscription = this.event(this.handleEvent, this);
    }
    onLastObserverRemoved() {
        this.subscription?.dispose();
        this.subscription = undefined;
        delete this.value;
    }
    hasValue() {
        return 'value' in this;
    }
    getValue() {
        if (this.subscription) {
            if (!this.hasValue()) {
                this.handleEvent(undefined);
            }
            return this.value;
        }
        else {
            return this.compute(undefined);
        }
    }
}
exports.ObservableFromEvent = ObservableFromEvent;
(function (ObservableFromEvent) {
    function create(event, compute, options) {
        return new ObservableFromEvent(event, compute, options);
    }
    ObservableFromEvent.create = create;
})(ObservableFromEvent || (exports.ObservableFromEvent = ObservableFromEvent = {}));
class ObservableSignalFromEvent extends observable_base_1.BaseObservable {
    constructor(event, options) {
        super();
        this.event = event;
        this.getUpdateScope = options?.getUpdateScope ?? observable_base_1.Observable.UpdateScope.getCurrent;
    }
    handleEvent() {
        observable_base_1.Observable.update(scope => {
            for (const observer of this.observers) {
                scope.push(observer, this);
                observer.handleChange(this);
            }
        }, this.getUpdateScope());
    }
    ;
    onFirstObserverAdded() {
        this.subscription = this.event(this.handleEvent, this);
    }
    onLastObserverRemoved() {
        this.subscription?.dispose();
        this.subscription = undefined;
    }
    getValue() {
        // NO OP
    }
}
exports.ObservableSignalFromEvent = ObservableSignalFromEvent;
(function (ObservableSignalFromEvent) {
    function create(event) {
        return new ObservableSignalFromEvent(event);
    }
    ObservableSignalFromEvent.create = create;
})(ObservableSignalFromEvent || (exports.ObservableSignalFromEvent = ObservableSignalFromEvent = {}));
//# sourceMappingURL=observable-from-event.js.map