"use strict";
// *****************************************************************************
// Copyright (C) 2026 Safi Seid-Ahmad, K2view and others.
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
const event_1 = require("@theia/core/lib/common/event");
const chai = require("chai");
const plugin_api_rpc_1 = require("../common/plugin-api-rpc");
const decorations_1 = require("./decorations");
const types_impl_1 = require("./types-impl");
const expect = chai.expect;
describe('DecorationsExtImpl', () => {
    let onDidChangeCalls;
    let decorationsExt;
    let onDidChangeFileDecorationsEmitter;
    beforeEach(() => {
        onDidChangeCalls = [];
        const decorationsMainMock = {
            $registerDecorationProvider: async () => undefined,
            $unregisterDecorationProvider: () => undefined,
            $onDidChange: (handle, resources) => {
                onDidChangeCalls.push(resources);
            }
        };
        const rpcMock = {
            getProxy(proxyId) {
                return (proxyId.id === plugin_api_rpc_1.PLUGIN_RPC_CONTEXT.DECORATIONS_MAIN.id
                    ? decorationsMainMock
                    : new Proxy({}, { get: () => () => undefined }));
            },
            set(_identifier, instance) {
                return instance;
            },
            dispose() { }
        };
        decorationsExt = new decorations_1.DecorationsExtImpl(rpcMock);
        onDidChangeFileDecorationsEmitter = new event_1.Emitter();
        decorationsExt.registerFileDecorationProvider({
            onDidChangeFileDecorations: onDidChangeFileDecorationsEmitter.event,
            provideFileDecoration: () => undefined
        }, { id: 'test.plugin', name: 'test' });
    });
    it('forwards small change events unchanged', () => {
        const uris = [1, 2, 3].map(i => types_impl_1.URI.parse(`file:///project/f${i}.ts`));
        onDidChangeFileDecorationsEmitter.fire(uris);
        expect(onDidChangeCalls).to.have.lengthOf(1);
        expect(onDidChangeCalls[0]).to.have.lengthOf(3);
    });
    it('forwards undefined change events as a flush', () => {
        onDidChangeFileDecorationsEmitter.fire(undefined);
        expect(onDidChangeCalls).to.have.lengthOf(1);
        // eslint-disable-next-line no-null/no-null
        expect(onDidChangeCalls[0]).to.equal(null);
    });
    it('sends a flush instead of truncating events exceeding the max event size', () => {
        const uris = [];
        for (let i = 0; i < 300; i++) {
            uris.push(types_impl_1.URI.parse(`file:///project/folder${i % 30}/f${i}.ts`));
        }
        onDidChangeFileDecorationsEmitter.fire(uris);
        expect(onDidChangeCalls).to.have.lengthOf(1);
        // eslint-disable-next-line no-null/no-null
        expect(onDidChangeCalls[0]).to.equal(null);
    });
});
//# sourceMappingURL=decorations.spec.js.map