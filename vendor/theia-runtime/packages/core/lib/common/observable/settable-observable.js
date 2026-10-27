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
exports.SettableObservable = void 0;
const observable_base_1 = require("./observable-base");
class SettableObservable extends observable_base_1.BaseObservable {
    constructor(initialValue, options) {
        super();
        this.value = initialValue;
        this.isEqual = options?.isEqual ?? ((a, b) => a === b);
    }
    getValue() {
        return this.value;
    }
    set(value, change, updateScope = observable_base_1.Observable.UpdateScope.getCurrent()) {
        if (change === undefined && this.isEqual(this.value, value)) {
            return;
        }
        observable_base_1.Observable.update(scope => {
            this.setValue(value);
            for (const observer of this.observers) {
                scope.push(observer, this);
                observer.handleChange(this, change);
            }
        }, updateScope);
    }
    setValue(newValue) {
        this.value = newValue;
    }
}
exports.SettableObservable = SettableObservable;
(function (SettableObservable) {
    function create(initialValue, options) {
        return new SettableObservable(initialValue, options);
    }
    SettableObservable.create = create;
})(SettableObservable || (exports.SettableObservable = SettableObservable = {}));
//# sourceMappingURL=settable-observable.js.map