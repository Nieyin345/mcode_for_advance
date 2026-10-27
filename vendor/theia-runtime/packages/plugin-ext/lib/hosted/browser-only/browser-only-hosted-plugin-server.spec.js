"use strict";
// *****************************************************************************
// Copyright (C) 2026 Robert Jandow
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
const jsdom_1 = require("@theia/core/lib/browser/test/jsdom");
// `BrowserOnlyHostedPluginServer` transitively imports `Endpoint` via `@theia/core/lib/browser`,
// which touches `document` at load time, so JSDOM is enabled before it for that import.
let disableJSDOM = (0, jsdom_1.enableJSDOM)();
const chai_1 = require("chai");
const inversify_1 = require("@theia/core/shared/inversify");
const common_1 = require("../../common");
const browser_only_hosted_plugin_server_1 = require("./browser-only-hosted-plugin-server");
disableJSDOM();
/* eslint-disable @typescript-eslint/no-explicit-any */
function plugin(name, version = '1.0.0') {
    return {
        type: common_1.PluginType.System,
        metadata: {
            host: 'main',
            model: { publisher: 'theia', name, version },
            lifecycle: {}
        }
    };
}
describe('BrowserOnlyHostedPluginServer', () => {
    // `fetchDeployedPlugins` builds the list URL through `Endpoint`, which reads `self.location`.
    before(() => { disableJSDOM = (0, jsdom_1.enableJSDOM)(); });
    after(() => disableJSDOM());
    const originalFetch = globalThis.fetch;
    let requestedUrls;
    function stubFetch(respond) {
        requestedUrls = [];
        globalThis.fetch = (async (url) => {
            requestedUrls.push(String(url));
            return respond();
        });
    }
    function createServer(options) {
        const container = new inversify_1.Container();
        container.bind(browser_only_hosted_plugin_server_1.BrowserOnlyHostedPluginServer).toSelf().inSingletonScope();
        if (options) {
            container.bind(browser_only_hosted_plugin_server_1.BrowserOnlyPluginOptions).toConstantValue(options);
        }
        return container.get(browser_only_hosted_plugin_server_1.BrowserOnlyHostedPluginServer);
    }
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });
    it('serves the plugins listed by the build', async () => {
        stubFetch(() => Response.json([plugin('a'), plugin('b')]));
        const server = createServer();
        (0, chai_1.expect)(await server.getDeployedPluginIds()).to.deep.equal(['theia.a@1.0.0', 'theia.b@1.0.0']);
        (0, chai_1.expect)(requestedUrls).to.deep.equal(['http://localhost/hostedPlugin/list.json']);
    });
    it('fetches the list only once', async () => {
        stubFetch(() => Response.json([plugin('a')]));
        const server = createServer();
        await server.getDeployedPluginIds();
        await server.getDeployedPluginIds();
        (0, chai_1.expect)(requestedUrls).to.have.lengthOf(1);
    });
    it('prefers the metadata supplied by an adopter over the list', async () => {
        stubFetch(() => Response.json([plugin('from-list')]));
        const server = createServer({ pluginMetadata: [plugin('from-options')] });
        (0, chai_1.expect)(await server.getDeployedPluginIds()).to.deep.equal(['theia.from-options@1.0.0']);
        (0, chai_1.expect)(requestedUrls).to.be.empty;
    });
    it('returns only the requested plugins', async () => {
        stubFetch(() => Response.json([plugin('a'), plugin('b'), plugin('c')]));
        const server = createServer();
        const deployed = await server.getDeployedPlugins(['theia.a@1.0.0', 'theia.c@1.0.0']);
        (0, chai_1.expect)(deployed.map(p => p.metadata.model.name)).to.deep.equal(['a', 'c']);
    });
    it('reports where the list could not be loaded from', async () => {
        stubFetch(() => new Response('', { status: 404, statusText: 'Not Found' }));
        const server = createServer();
        await server.getDeployedPluginIds().then(() => chai_1.expect.fail('should have rejected'), error => (0, chai_1.expect)(error.message).to.contain('http://localhost/hostedPlugin/list.json').and.to.contain('404'));
    });
    it('fetches the list again after a failed attempt', async () => {
        let attempt = 0;
        stubFetch(() => ++attempt === 1 ? new Response('', { status: 503 }) : Response.json([plugin('a')]));
        const server = createServer();
        await server.getDeployedPluginIds().catch(() => undefined);
        (0, chai_1.expect)(await server.getDeployedPluginIds()).to.deep.equal(['theia.a@1.0.0']);
        (0, chai_1.expect)(requestedUrls).to.have.lengthOf(2);
    });
    it('rejects a list that is not an array', async () => {
        stubFetch(() => Response.json({ plugins: [] }));
        const server = createServer();
        await server.getDeployedPluginIds().then(() => chai_1.expect.fail('should have rejected'), error => (0, chai_1.expect)(error.message).to.contain('expected an array'));
    });
});
//# sourceMappingURL=browser-only-hosted-plugin-server.spec.js.map