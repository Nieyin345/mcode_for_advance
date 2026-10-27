"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource and others.
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
const chai_1 = require("chai");
const plugin_http_resolver_1 = require("./plugin-http-resolver");
describe('HttpPluginDeployerResolver', () => {
    function createContext(originId) {
        return {
            getOriginId: () => originId
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        };
    }
    it('should reject a malformed link URI', async () => {
        const resolver = new plugin_http_resolver_1.HttpPluginDeployerResolver();
        let error;
        try {
            await resolver.resolve(createContext(':::not a url'));
        }
        catch (e) {
            error = e;
        }
        (0, chai_1.expect)(error).to.be.an.instanceOf(Error);
        (0, chai_1.expect)(error.message).to.contain('invalid link URI');
    });
});
//# sourceMappingURL=plugin-http-resolver.spec.js.map