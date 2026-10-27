/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { Emitter, Event } from './event.js';
import { DisposableStore } from './lifecycle.js';
const shortcutEvent = Object.freeze(function (callback, context) {
    const handle = setTimeout(callback.bind(context), 0);
    return { dispose() { clearTimeout(handle); } };
});
export var CancellationToken;
(function (CancellationToken) {
    function isCancellationToken(thing) {
        if (thing === CancellationToken.None || thing === CancellationToken.Cancelled) {
            return true;
        }
        if (thing instanceof MutableToken) {
            return true;
        }
        if (!thing || typeof thing !== 'object') {
            return false;
        }
        return typeof thing.isCancellationRequested === 'boolean'
            && typeof thing.onCancellationRequested === 'function';
    }
    CancellationToken.isCancellationToken = isCancellationToken;
    CancellationToken.None = Object.freeze({
        isCancellationRequested: false,
        onCancellationRequested: Event.None
    });
    CancellationToken.Cancelled = Object.freeze({
        isCancellationRequested: true,
        onCancellationRequested: shortcutEvent
    });
})(CancellationToken || (CancellationToken = {}));
class MutableToken {
    constructor() {
        this._isCancelled = false;
        this._emitter = null;
    }
    cancel() {
        if (!this._isCancelled) {
            this._isCancelled = true;
            if (this._emitter) {
                this._emitter.fire(undefined);
                this.dispose();
            }
        }
    }
    get isCancellationRequested() {
        return this._isCancelled;
    }
    get onCancellationRequested() {
        if (this._isCancelled) {
            return shortcutEvent;
        }
        if (!this._emitter) {
            this._emitter = new Emitter();
        }
        return this._emitter.event;
    }
    dispose() {
        if (this._emitter) {
            this._emitter.dispose();
            this._emitter = null;
        }
    }
}
export class CancellationTokenSource {
    constructor(parent) {
        this._token = undefined;
        this._parentListener = undefined;
        this._parentListener = parent && parent.onCancellationRequested(this.cancel, this);
    }
    get token() {
        if (!this._token) {
            // be lazy and create the token only when
            // actually needed
            this._token = new MutableToken();
        }
        return this._token;
    }
    cancel() {
        if (!this._token) {
            // save an object by returning the default
            // cancelled token when cancellation happens
            // before someone asks for the token
            this._token = CancellationToken.Cancelled;
        }
        else if (this._token instanceof MutableToken) {
            // actually cancel
            this._token.cancel();
        }
    }
    dispose(cancel = false) {
        if (cancel) {
            this.cancel();
        }
        this._parentListener?.dispose();
        if (!this._token) {
            // ensure to initialize with an empty token if we had none
            this._token = CancellationToken.None;
        }
        else if (this._token instanceof MutableToken) {
            // actually dispose
            this._token.dispose();
        }
    }
}
export function cancelOnDispose(store) {
    const source = new CancellationTokenSource();
    store.add({ dispose() { source.cancel(); } });
    return source.token;
}
/**
 * A pool that aggregates multiple cancellation tokens. The pool's own token
 * (accessible via `pool.token`) is cancelled only after every token added
 * to the pool has been cancelled. Adding tokens after the pool token has
 * been cancelled has no effect.
 */
export class CancellationTokenPool {
    constructor() {
        this._source = new CancellationTokenSource();
        this._listeners = new DisposableStore();
        this._total = 0;
        this._cancelled = 0;
        this._isDone = false;
    }
    get token() {
        return this._source.token;
    }
    /**
     * Add a token to the pool. If the token is already cancelled it is counted
     * immediately. Tokens added after the pool token has been cancelled are ignored.
     */
    add(token) {
        if (this._isDone) {
            return;
        }
        this._total++;
        if (token.isCancellationRequested) {
            this._cancelled++;
            this._check();
            return;
        }
        const d = token.onCancellationRequested(() => {
            d.dispose();
            this._cancelled++;
            this._check();
        });
        this._listeners.add(d);
    }
    _check() {
        if (!this._isDone && this._total > 0 && this._total === this._cancelled) {
            this._isDone = true;
            this._listeners.dispose();
            this._source.cancel();
        }
    }
    dispose() {
        this._listeners.dispose();
        this._source.dispose();
    }
}
//# sourceMappingURL=cancellation.js.map