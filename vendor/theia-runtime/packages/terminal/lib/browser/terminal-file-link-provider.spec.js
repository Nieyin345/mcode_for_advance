"use strict";
// *****************************************************************************
// Copyright (C) 2026 JuliaHub, Inc. and others.
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
const disableJSDOM = (0, jsdom_1.enableJSDOM)();
// Importing the provider pulls in xterm, which probes a canvas 2d context on load; JSDOM has no
// canvas backend, so stub it out to keep this spec runnable without the native `canvas` package.
HTMLCanvasElement.prototype.getContext = () => undefined;
const frontend_application_config_provider_1 = require("@theia/core/lib/browser/frontend-application-config-provider");
frontend_application_config_provider_1.FrontendApplicationConfigProvider.set({});
const chai = require("chai");
const uri_1 = require("@theia/core/lib/common/uri");
const terminal_file_link_provider_1 = require("./terminal-file-link-provider");
disableJSDOM();
const expect = chai.expect;
class TestFileLinkProvider extends terminal_file_link_provider_1.FileLinkProvider {
    constructor() {
        super();
        this.loggedErrors = [];
        this.logger = {
            error: (message) => { this.loggedErrors.push(String(message)); }
        };
    }
    exposeToURI(match, cwd) {
        return this.toURI(match, cwd);
    }
}
function terminalWithCwd(cwd) {
    return { lastCwd: cwd };
}
describe('FileLinkProvider', () => {
    const cwd = new uri_1.default('file:///home/user/project');
    describe('#toURI', () => {
        it('should skip a URL authority path beginning with "//" instead of throwing', async () => {
            const provider = new TestFileLinkProvider();
            // The '//host/path' the file-path regex matches from a printed URL (its ':' is excluded).
            expect(await provider.exposeToURI('//juliahub.com/products/dyad', cwd)).to.equal(undefined);
            expect(await provider.exposeToURI('//github.com/DyadLang/DyadIssues', cwd)).to.equal(undefined);
        });
        it('should still resolve a genuine absolute local path', async () => {
            const provider = new TestFileLinkProvider();
            const uri = await provider.exposeToURI('/home/user/project/file.ts', cwd);
            expect(uri).to.not.equal(undefined);
            expect(uri.path.toString()).to.equal('/home/user/project/file.ts');
        });
    });
    describe('#provideLinks', () => {
        it('should not produce a file link or log an error for a printed URL', async () => {
            const provider = new TestFileLinkProvider();
            const links = await provider.provideLinks('see https://juliahub.com/products/dyad for details', terminalWithCwd(cwd));
            expect(links).to.deep.equal([]);
            expect(provider.loggedErrors).to.deep.equal([]);
        });
        it('should not throw or log for a printed file:// URL', async () => {
            const provider = new TestFileLinkProvider();
            // ':' is excluded, so a file:// URL survives as a '///path' candidate the guard skips;
            // it is not linkified here today. Documents the no-throw behavior — making file:// links
            // clickable would be a separate feature.
            const links = await provider.provideLinks('open file:///home/user/project/file.ts now', terminalWithCwd(cwd));
            expect(links).to.deep.equal([]);
            expect(provider.loggedErrors).to.deep.equal([]);
        });
    });
});
//# sourceMappingURL=terminal-file-link-provider.spec.js.map