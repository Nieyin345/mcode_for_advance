"use strict";
// *****************************************************************************
// Copyright (C) 2020 Red Hat, Inc. and others.
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
exports.DecorationsServiceImpl = exports.DecorationsService = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("inversify");
const promise_util_1 = require("../common/promise-util");
const common_1 = require("../common");
const ternary_search_tree_1 = require("../common/ternary-search-tree");
const debounce = require("lodash.debounce");
exports.DecorationsService = Symbol('DecorationsService');
class DecorationDataRequest {
    constructor(source, thenable, 
    /**
     * Last settled decoration from before this request started. It is served while
     * the request is in flight and used to detect removals when it resolves.
     */
    previous) {
        this.source = source;
        this.thenable = thenable;
        this.previous = previous;
    }
}
/**
 * A decoration that a flush event marked as possibly outdated. It is served until its
 * resource is queried again, which triggers the re-fetch.
 */
class StaleDecoration {
    constructor(value) {
        this.value = value;
    }
}
/**
 * The decoration an entry last settled on: the resolved decoration itself, the
 * pre-request value of an in-flight request, or the flushed value of a stale entry.
 */
function lastKnownDecoration(entry) {
    if (entry instanceof DecorationDataRequest) {
        return entry.previous;
    }
    if (entry instanceof StaleDecoration) {
        return entry.value;
    }
    return entry ?? undefined;
}
class DecorationProviderWrapper {
    constructor(provider, 
    /** Reports a changed decoration, or `undefined` when the decoration was removed. */
    notifyDecorationChange, 
    /** Reports that all decorations of this provider may have changed. */
    notifyFlush) {
        this.provider = provider;
        this.notifyDecorationChange = notifyDecorationChange;
        this.notifyFlush = notifyFlush;
        this.data = ternary_search_tree_1.TernarySearchTree.forUris(true);
        this.disposable = this.provider.onDidChange(uris => {
            if (!uris) {
                this.flush();
            }
            else {
                // selective changes -> re-fetch the given resources
                for (const uri of uris) {
                    this.fetchData(uri);
                }
            }
        });
    }
    dispose() {
        this.disposable.dispose();
        this.data.clear();
    }
    /**
     * Handles a flush event: all cached data is dropped to be re-fetched on demand.
     * Previously fetched decorations are kept as {@link StaleDecoration stale} values
     * that are served until the re-fetch of their resource settles, so that displayed
     * decorations do not blink out while the round trip is in flight.
     */
    flush() {
        const stale = [];
        this.data.forEach((value, key) => {
            if (value instanceof DecorationDataRequest) {
                value.source.cancel();
            }
            const decoration = lastKnownDecoration(value);
            if (decoration) {
                stale.push([key, new StaleDecoration(decoration)]);
            }
        });
        this.data.clear();
        for (const [key, value] of stale) {
            this.data.set(key, value);
        }
        this.notifyFlush();
    }
    getOrRetrieve(uri, includeChildren, callback) {
        let item = this.data.get(uri);
        if (item === undefined || item instanceof StaleDecoration) {
            // unknown or stale -> trigger request
            item = this.fetchData(uri);
        }
        // the result, or the last known decoration while a request is in flight
        const decoration = lastKnownDecoration(item);
        if (decoration) {
            callback(decoration, false);
        }
        if (includeChildren) {
            // (last known decorations of) children
            const iter = this.data.findSuperstr(uri);
            if (iter) {
                let next = iter.next();
                while (!next.done) {
                    const value = lastKnownDecoration(next.value);
                    if (value) {
                        callback(value, true);
                    }
                    next = iter.next();
                }
            }
        }
    }
    fetchData(uri) {
        // check for pending request and cancel it, keeping the last settled value
        const existing = this.data.get(uri);
        const previous = lastKnownDecoration(existing);
        if (existing instanceof DecorationDataRequest) {
            existing.source.cancel();
            this.data.delete(uri);
        }
        const source = new common_1.CancellationTokenSource();
        const dataOrThenable = this.provider.provideDecorations(uri, source.token);
        if (!(0, promise_util_1.isThenable)(dataOrThenable)) {
            // sync -> we have a result now
            return this.keepItem(uri, dataOrThenable, previous);
        }
        else {
            // async -> we have a result soon
            const request = new DecorationDataRequest(source, Promise.resolve(dataOrThenable).then(data => {
                if (this.data.get(uri) === request) {
                    this.keepItem(uri, data, request.previous);
                }
            }).catch(err => {
                if (!(err instanceof Error && err.name === 'Canceled' && err.message === 'Canceled') && this.data.get(uri) === request) {
                    this.data.delete(uri);
                }
            }), previous);
            this.data.set(uri, request);
            return request;
        }
    }
    keepItem(uri, data, previous) {
        // eslint-disable-next-line no-null/no-null
        const deco = data ? data : null;
        this.data.set(uri, deco);
        if (deco || previous) {
            // only notify when something actually changed: a decoration appeared or
            // changed, or a previously known decoration was removed. Resources resolving
            // to "no decoration" from an unknown or pending state stay silent so that
            // on-demand queries of undecorated resources cause no render churn.
            this.notifyDecorationChange(uri, deco ?? undefined);
        }
        return deco;
    }
}
let DecorationsServiceImpl = class DecorationsServiceImpl {
    constructor() {
        this.data = [];
        this.onDidChangeDecorationsEmitter = new common_1.Emitter();
        /**
         * Accumulates decoration changes until the batched {@link onDidChangeDecorations}
         * event fires. `undefined` values mark removed decorations.
         */
        this.pendingChanges = new Map();
        this.pendingFlush = false;
        this.onDidChangeDecorations = this.onDidChangeDecorationsEmitter.event;
        /** Coalesces all changes of the same tick into a single event. */
        this.fireSoon = debounce(() => this.fireChangeEvent(), 0);
    }
    dispose() {
        this.fireSoon.cancel();
        this.onDidChangeDecorationsEmitter.dispose();
    }
    registerDecorationsProvider(provider) {
        const wrapper = new DecorationProviderWrapper(provider, (uri, decoration) => this.notifyDecorationChange(uri, decoration), () => this.notifyFlush());
        this.data.push(wrapper);
        return common_1.Disposable.create(() => {
            // dispose and remove the provider, then signal that
            // any of its previously provided decorations may be gone.
            this.data.splice(this.data.indexOf(wrapper), 1);
            wrapper.dispose();
            this.notifyFlush();
        });
    }
    getDecoration(uri, includeChildren) {
        const data = [];
        let containsChildren = false;
        for (const wrapper of this.data) {
            wrapper.getOrRetrieve(uri, includeChildren, (deco, isChild) => {
                if (!isChild || deco.bubble) {
                    data.push(deco);
                    containsChildren = isChild || containsChildren;
                }
            });
        }
        return data;
    }
    notifyDecorationChange(uri, decoration) {
        this.pendingChanges.set(uri.toString(), decoration);
        this.fireSoon();
    }
    notifyFlush() {
        this.pendingFlush = true;
        this.fireSoon();
    }
    fireChangeEvent() {
        const event = new Map();
        if (!this.pendingFlush) {
            for (const [uri, decoration] of this.pendingChanges) {
                if (decoration) {
                    event.set(uri, decoration);
                }
            }
        }
        this.pendingFlush = false;
        this.pendingChanges.clear();
        this.onDidChangeDecorationsEmitter.fire(event);
    }
};
exports.DecorationsServiceImpl = DecorationsServiceImpl;
exports.DecorationsServiceImpl = DecorationsServiceImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], DecorationsServiceImpl);
//# sourceMappingURL=decorations-service.js.map