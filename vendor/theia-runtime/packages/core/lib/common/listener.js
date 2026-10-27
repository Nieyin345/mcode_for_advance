"use strict";
// *****************************************************************************
// Copyright (C) 2025 ST Microelectronics and others.
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
exports.ListenerList = exports.Listener = void 0;
const disposable_1 = require("./disposable");
var Listener;
(function (Listener) {
    Listener.None = () => disposable_1.Disposable.NULL;
    /**
     * Convenience function to await all listener invocations
     * @param value The value to invoke the listeners with
     * @param list the listener list to invoke
     * @returns the return values from the listener invocation
     */
    async function awaitAll(value, list) {
        const promises = [];
        list.invoke(value, promise => {
            promises.push(promise);
        });
        return await Promise.all(promises);
    }
    Listener.awaitAll = awaitAll;
})(Listener || (exports.Listener = Listener = {}));
class ListenerList {
    constructor() {
        this.registeredCount = 1; // start at 1 to prevent falsy madness
        this.registration = this.register.bind(this);
    }
    register(listener) {
        const reg = { id: this.registeredCount++, listener };
        if (!this.listeners) {
            this.listeners = reg;
        }
        else if (Array.isArray(this.listeners)) {
            this.listeners.push(reg);
        }
        else {
            this.listeners = [this.listeners, reg];
        }
        return disposable_1.Disposable.create(() => {
            this.remove(reg.id);
        });
    }
    remove(id) {
        if (Array.isArray(this.listeners)) {
            const index = this.listeners.findIndex(v => v.id === id);
            if (index >= 0) {
                this.listeners.splice(index, 1);
            }
        }
        else if (this.listeners && this.listeners.id === id) {
            this.listeners = undefined;
        }
    }
    invoke(e, callback) {
        if (Array.isArray(this.listeners)) {
            for (const l of this.listeners) {
                callback(l.listener(e));
            }
        }
        else if (this.listeners) {
            callback(this.listeners.listener(e));
        }
    }
}
exports.ListenerList = ListenerList;
//# sourceMappingURL=listener.js.map