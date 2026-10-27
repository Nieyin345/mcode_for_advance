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
// `PluginIconService` transitively imports monaco modules that touch `document` at load time,
// and `toPluginUrl` itself needs `self.location` (via `Endpoint`) at call time, so JSDOM is
// re-enabled for the test run below.
let disableJSDOM = (0, jsdom_1.enableJSDOM)();
const chai_1 = require("chai");
const vscode_uri_1 = require("@theia/core/shared/vscode-uri");
const constants_1 = require("@theia/plugin-utils/lib/common/constants");
const plugin_icon_service_1 = require("./plugin-icon-service");
disableJSDOM();
/** Widens `protected` members to `public` so the tests can call them directly. */
class TestablePluginIconService extends plugin_icon_service_1.PluginIconService {
    callToPluginRelativePath(fontUri) {
        return this.toPluginRelativePath(fontUri);
    }
    callToPluginUrl(id, relativePath) {
        return this.toPluginUrl(id, relativePath);
    }
}
describe('PluginIconService', () => {
    before(() => disableJSDOM = (0, jsdom_1.enableJSDOM)());
    after(() => disableJSDOM());
    let service;
    beforeEach(() => {
        service = new TestablePluginIconService();
    });
    describe('toPluginRelativePath', () => {
        it('drops the plugin id segment of a plugin asset URI and keeps the rest verbatim', () => {
            const uri = vscode_uri_1.URI.parse(`${constants_1.PLUGINS_SCHEME}:/acme_ext/dist/font.woff`);
            (0, chai_1.expect)(service.callToPluginRelativePath(uri)).to.equal('dist/font.woff');
        });
        it('resolves a deeply nested path under a plugin asset URI', () => {
            const uri = vscode_uri_1.URI.parse(`${constants_1.PLUGINS_SCHEME}:/acme_ext/a/b/c/d/font.woff`);
            (0, chai_1.expect)(service.callToPluginRelativePath(uri)).to.equal('a/b/c/d/font.woff');
        });
        it('resolves a single-segment path under a plugin asset URI', () => {
            const uri = vscode_uri_1.URI.parse(`${constants_1.PLUGINS_SCHEME}:/acme_ext/font.woff`);
            (0, chai_1.expect)(service.callToPluginRelativePath(uri)).to.equal('font.woff');
        });
        it('decodes characters that were percent-encoded in a plugin asset URI', () => {
            const uri = vscode_uri_1.URI.parse(`${constants_1.PLUGINS_SCHEME}:/acme_ext/dist/my%20font%23file.woff`);
            (0, chai_1.expect)(service.callToPluginRelativePath(uri)).to.equal('dist/my font#file.woff');
        });
        it('falls back to cutting a backend (non-plugin-asset) path at its `extension` segment', () => {
            const uri = vscode_uri_1.URI.parse('file:///plugins/acme.ext-1.0.0/extension/dist/font.woff');
            (0, chai_1.expect)(service.callToPluginRelativePath(uri)).to.equal('dist/font.woff');
        });
        it('returns an empty string for a backend path that has no `extension` segment', () => {
            const uri = vscode_uri_1.URI.parse('file:///plugins/acme.ext-1.0.0/dist/font.woff');
            (0, chai_1.expect)(service.callToPluginRelativePath(uri)).to.equal('');
        });
    });
    describe('toPluginUrl', () => {
        it('keeps `/` literal while percent-encoding special characters within each segment', () => {
            const url = service.callToPluginUrl('acme.ext', 'dist/sub dir/a#b?c%d.woff');
            (0, chai_1.expect)(url.toString()).to.match(/\/hostedPlugin\/acme_ext\/dist\/sub%20dir\/a%23b%3Fc%25d\.woff$/);
            // the slashes between segments must not themselves be encoded
            (0, chai_1.expect)(url.toString()).to.not.include('%2F');
        });
        it('replaces non-word characters in the plugin id to build the URL segment', () => {
            const url = service.callToPluginUrl('acme.ext-1.0.0', 'font.woff');
            (0, chai_1.expect)(url.toString()).to.match(/\/hostedPlugin\/acme_ext_1_0_0\/font\.woff$/);
        });
    });
});
//# sourceMappingURL=plugin-icon-service.spec.js.map