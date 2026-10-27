"use strict";
// *****************************************************************************
// Copyright (C) 2026 Maksim Kachurin and others.
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
const fs = require("fs");
const os = require("os");
const path = require("path");
const constants_1 = require("./constants");
const plugin_model_1 = require("./plugin-model");
const plugin_model_2 = require("../node/plugin-model");
const test_helpers_1 = require("./test-helpers");
describe('plugin-model', () => {
    describe('getPluginId', () => {
        it('sanitizes publisher and name', () => {
            (0, chai_1.expect)((0, plugin_model_1.getPluginId)({ publisher: 'dbaeumer', name: 'vscode-eslint' })).to.equal('dbaeumer_vscode_eslint');
        });
        it('uses unpublished publisher when publisher is missing', () => {
            (0, chai_1.expect)((0, plugin_model_1.getPluginId)({ name: 'my-ext' })).to.equal((0, plugin_model_1.getPluginId)({ publisher: constants_1.UNPUBLISHED, name: 'my-ext' }));
        });
    });
    describe('toPluginUrl', () => {
        it('encodes each path segment and keeps separators for static hosting', () => {
            const url = (0, plugin_model_1.toPluginUrl)({ publisher: 'vscode', name: 'theme-monokai' }, './themes/monokai-color-theme.json');
            (0, chai_1.expect)(url).to.equal('hostedPlugin/vscode_theme_monokai/themes/monokai-color-theme.json');
        });
        it('encodes special characters inside a segment', () => {
            (0, chai_1.expect)((0, plugin_model_1.toPluginUrl)({ publisher: 'acme', name: 'ext' }, 'media/my icon.png'))
                .to.equal('hostedPlugin/acme_ext/media/my%20icon.png');
            (0, chai_1.expect)((0, plugin_model_1.toPluginUrl)({ publisher: 'acme', name: 'ext' }, '$(folder)'))
                .to.equal('hostedPlugin/acme_ext/%24(folder)');
        });
        it('resolves .. within the plugin root and ignores leading ..', () => {
            (0, chai_1.expect)((0, plugin_model_1.toPluginUrl)({ publisher: 'acme', name: 'ext' }, 'themes/../icons/a.png'))
                .to.equal('hostedPlugin/acme_ext/icons/a.png');
            (0, chai_1.expect)((0, plugin_model_1.toPluginUrl)({ publisher: 'acme', name: 'ext' }, '../secret.json'))
                .to.equal('hostedPlugin/acme_ext/secret.json');
        });
    });
    describe('encodePluginAssetPath', () => {
        it('encodes segments but keeps separators', () => {
            (0, chai_1.expect)((0, plugin_model_1.encodePluginAssetPath)('/acme_ext/sub dir/a#b?c%d.json'))
                .to.equal('/acme_ext/sub%20dir/a%23b%3Fc%25d.json');
        });
        it('round-trips the decoded path of a plugin asset URI', () => {
            for (const relativePath of ['a#b?c%d.json', 'my icon.png', 'themes/dark+.json', 'sub dir/x[1].woff']) {
                const uri = (0, plugin_model_1.toPluginUri)({ publisher: 'acme', name: 'ext' }, relativePath);
                // what `URI.path` hands a consumer back
                const decoded = decodeURIComponent(uri.substring(`${constants_1.PLUGINS_SCHEME}:`.length));
                (0, chai_1.expect)(`${constants_1.PLUGINS_SCHEME}:${(0, plugin_model_1.encodePluginAssetPath)(decoded)}`).to.equal(uri);
            }
        });
    });
    describe('pickEngineType', () => {
        it('prefers theiaPlugin over vscode when both are declared', () => {
            (0, chai_1.expect)((0, plugin_model_1.pickEngineType)((0, test_helpers_1.manifest)({
                name: 'both-engines',
                engines: { vscode: '^1.0.0', theiaPlugin: '*' }
            }))).to.equal('theiaPlugin');
        });
        it('returns vscode when only vscode engine is declared', () => {
            (0, chai_1.expect)((0, plugin_model_1.pickEngineType)((0, test_helpers_1.manifest)({
                name: 'vscode-only',
                engines: { vscode: '^1.0.0' }
            }))).to.equal('vscode');
        });
        it('throws when no supported engine is declared', () => {
            (0, chai_1.expect)(() => (0, plugin_model_1.pickEngineType)((0, test_helpers_1.manifest)({ name: 'no-engine' }))).to.throw(/No vscode or theiaPlugin engine/);
        });
    });
    describe('applyTrustExtraction', () => {
        it('copies untrusted workspace support when declared', () => {
            const result = {};
            (0, plugin_model_1.applyTrustExtraction)((0, test_helpers_1.manifest)({
                name: 'trusted',
                capabilities: { untrustedWorkspaces: { supported: 'limited' } }
            }), result);
            (0, chai_1.expect)(result.untrustedWorkspacesSupport).to.equal('limited');
        });
        it('leaves result unchanged when capabilities are absent', () => {
            const result = {};
            (0, plugin_model_1.applyTrustExtraction)((0, test_helpers_1.manifest)({ name: 'plain' }), result);
            (0, chai_1.expect)(result.untrustedWorkspacesSupport).to.equal(undefined);
        });
    });
    describe('getPluginRootFileUrl', () => {
        let tmpDir;
        before(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-utils-root-'));
            fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Readme');
        });
        after(() => {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });
        it('finds readme files case-insensitively', () => {
            const url = (0, plugin_model_2.getPluginRootFileUrl)((0, test_helpers_1.manifest)({ name: 'docs', packagePath: tmpDir }), ['readme.md']);
            (0, chai_1.expect)(url).to.equal('hostedPlugin/acme_docs/README.md');
        });
        it('returns undefined when directory is missing', () => {
            (0, chai_1.expect)((0, plugin_model_2.getPluginRootFileUrl)((0, test_helpers_1.manifest)({ name: 'missing', packagePath: '/no/such/path' }), ['readme.md'])).to.equal(undefined);
        });
    });
    describe('buildEntryPointForTheia', () => {
        it('maps theiaPlugin entry points and headless script', () => {
            const entryPoint = (0, plugin_model_1.buildEntryPointForTheia)((0, test_helpers_1.manifest)({
                name: 'theia-ext',
                theiaPlugin: {
                    frontend: './lib/browser/main.js',
                    backend: './lib/node/main.js',
                    headless: './lib/headless.js'
                }
            }));
            (0, chai_1.expect)(entryPoint).to.deep.equal({
                frontend: './lib/browser/main.js',
                backend: './lib/node/main.js',
                headless: './lib/headless.js'
            });
        });
    });
    describe('buildEntryPointForVsCode', () => {
        it('prefers browser entry for ui-only extensions in web mode', () => {
            const entryPoint = (0, plugin_model_1.buildEntryPointForVsCode)((0, test_helpers_1.manifest)({
                name: 'ui-extension',
                browser: './dist/browser/extension.js',
                main: './dist/node/extension.js',
                extensionKind: ['ui']
            }), { uiKind: 'web' });
            (0, chai_1.expect)(entryPoint.frontend).to.equal('./dist/browser/extension.js');
            (0, chai_1.expect)(entryPoint.backend).to.equal(undefined);
        });
        it('uses main as backend when browser is absent', () => {
            const entryPoint = (0, plugin_model_1.buildEntryPointForVsCode)((0, test_helpers_1.manifest)({
                name: 'workspace-extension',
                main: './dist/node/extension.js'
            }), { uiKind: 'web' });
            (0, chai_1.expect)(entryPoint.backend).to.equal('./dist/node/extension.js');
            (0, chai_1.expect)(entryPoint.frontend).to.equal(undefined);
        });
        it('prefers backend when both main and browser exist without ui-only web hint', () => {
            const entryPoint = (0, plugin_model_1.buildEntryPointForVsCode)((0, test_helpers_1.manifest)({
                name: 'hybrid',
                browser: './dist/browser/extension.js',
                main: './dist/node/extension.js',
                extensionKind: ['workspace', 'ui']
            }), { uiKind: 'web' });
            (0, chai_1.expect)(entryPoint.backend).to.equal('./dist/node/extension.js');
            (0, chai_1.expect)(entryPoint.frontend).to.equal(undefined);
        });
        it('forwards headless script from theiaPlugin section', () => {
            const entryPoint = (0, plugin_model_1.buildEntryPointForVsCode)((0, test_helpers_1.manifest)({
                name: 'headless',
                main: './main.js',
                theiaPlugin: { headless: './headless.js' }
            }));
            (0, chai_1.expect)(entryPoint.headless).to.equal('./headless.js');
        });
    });
    describe('buildModel', () => {
        it('builds theia plugin model with defaults', () => {
            const model = (0, plugin_model_1.buildModelForTheia)((0, test_helpers_1.manifest)({
                name: 'Sample',
                publisher: 'Acme',
                packageUri: `${constants_1.PLUGINS_SCHEME}:/acme_Sample/`
            }));
            (0, chai_1.expect)(model.id).to.equal('acme.sample');
            (0, chai_1.expect)(model.engine).to.deep.equal({ type: 'theiaPlugin', version: '*' });
            (0, chai_1.expect)(model.displayName).to.equal('Test Extension');
            (0, chai_1.expect)(model.packageUri).to.equal(`${constants_1.PLUGINS_SCHEME}:/acme_Sample/`);
        });
        it('builds vscode model with icon url and web entry point', () => {
            const model = (0, plugin_model_1.buildModelForVsCode)((0, test_helpers_1.manifest)({
                name: 'icon-ext',
                icon: './media/icon.png',
                browser: './browser.js',
                extensionKind: ['ui'],
                engines: { vscode: '^1.90.0' }
            }), { uiKind: 'web' });
            (0, chai_1.expect)(model.engine).to.deep.equal({ type: 'vscode', version: '^1.90.0' });
            (0, chai_1.expect)(model.iconUrl).to.equal('hostedPlugin/acme_icon_ext/media/icon.png');
            (0, chai_1.expect)(model.entryPoint.frontend).to.equal('./browser.js');
        });
        it('uses UNPUBLISHED publisher and displayName fallback', () => {
            const model = (0, plugin_model_1.buildModel)((0, test_helpers_1.manifest)({ name: 'anon', publisher: undefined, displayName: undefined }), 'vscode');
            (0, chai_1.expect)(model.publisher).to.equal(constants_1.UNPUBLISHED);
            (0, chai_1.expect)(model.displayName).to.equal('anon');
        });
    });
    describe('buildLifecycle', () => {
        it('uses theia start/stop for theiaPlugin engine', () => {
            const lifecycle = (0, plugin_model_1.buildLifecycle)((0, test_helpers_1.manifest)({ name: 'theia', publisher: 'acme' }), 'theiaPlugin');
            (0, chai_1.expect)(lifecycle.startMethod).to.equal(constants_1.THEIA_PLUGIN_START_METHOD);
            (0, chai_1.expect)(lifecycle.stopMethod).to.equal(constants_1.THEIA_PLUGIN_STOP_METHOD);
            (0, chai_1.expect)(lifecycle.frontendModuleName).to.equal('acme_theia');
            (0, chai_1.expect)(lifecycle.frontendInitPath).to.equal(undefined);
        });
        it('uses vscode activate/deactivate lifecycle', () => {
            const lifecycle = (0, plugin_model_1.buildLifecycle)((0, test_helpers_1.manifest)({ name: 'sample', publisher: 'acme' }), 'vscode');
            (0, chai_1.expect)(lifecycle.startMethod).to.equal(constants_1.VSCODE_EXTENSION_ACTIVATE);
            (0, chai_1.expect)(lifecycle.stopMethod).to.equal(constants_1.VSCODE_EXTENSION_DEACTIVATE);
            (0, chai_1.expect)(lifecycle.frontendInitPath).to.equal(constants_1.VSCODE_FRONTEND_INIT);
            (0, chai_1.expect)(lifecycle.frontendModuleName).to.equal('acme_sample');
        });
    });
});
//# sourceMappingURL=plugin-model.spec.js.map