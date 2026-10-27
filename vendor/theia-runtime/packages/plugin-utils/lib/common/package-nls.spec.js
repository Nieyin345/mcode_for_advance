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
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const package_nls_1 = require("./package-nls");
const package_nls_2 = require("../node/package-nls");
describe('package-nls', () => {
    describe('coerceLocalizations', () => {
        it('passes through string values', () => {
            (0, chai_1.expect)((0, package_nls_1.coerceLocalizations)({ key: 'value' })).to.deep.equal({ key: 'value' });
        });
        it('extracts message from LocalizeInfo objects', () => {
            (0, chai_1.expect)((0, package_nls_1.coerceLocalizations)({ key: { message: 'Hello', comment: 'greeting' } })).to.deep.equal({ key: 'Hello' });
        });
        it('marks invalid values explicitly', () => {
            (0, chai_1.expect)((0, package_nls_1.coerceLocalizations)({ key: 42 })).to.deep.equal({ key: 'INVALID TRANSLATION VALUE' });
        });
    });
    describe('localizeWithResolver', () => {
        it('localizes nested structures and leaves unknown keys unchanged', () => {
            const localized = (0, package_nls_1.localizeWithResolver)({
                title: '%title.key%',
                nested: [{ label: '%nested.key%' }],
                plain: 'unchanged'
            }, key => (key === 'title.key' ? 'Title' : undefined));
            (0, chai_1.expect)(localized).to.deep.equal({
                title: 'Title',
                nested: [{ label: '%nested.key%' }],
                plain: 'unchanged'
            });
        });
        it('keeps %key% when resolve returns undefined or an empty string', () => {
            (0, chai_1.expect)((0, package_nls_1.localizeWithResolver)('%missing.key%', () => undefined)).to.equal('%missing.key%');
            (0, chai_1.expect)((0, package_nls_1.localizeWithResolver)('%empty.key%', () => '')).to.equal('%empty.key%');
        });
        it('ignores strings that are not %key% placeholders', () => {
            (0, chai_1.expect)((0, package_nls_1.localizeWithResolver)('%not-closed', () => 'x')).to.equal('%not-closed');
            (0, chai_1.expect)((0, package_nls_1.localizeWithResolver)('100%', () => 'x')).to.equal('100%');
        });
    });
    describe('localizePackage', () => {
        it('uses translation bundle before default bundle', () => {
            const localized = (0, package_nls_1.localizePackage)({ displayName: '%name.key%' }, {
                translation: { 'name.key': 'Translated' },
                default: { 'name.key': 'Default' }
            }, () => 'callback-should-not-run');
            (0, chai_1.expect)(localized).to.deep.equal({ displayName: 'Translated' });
        });
        it('invokes callback for default bundle when translation is missing', () => {
            const localized = (0, package_nls_1.localizePackage)({ displayName: '%name.key%' }, { default: { 'name.key': 'Default value' } }, (_key, defaultValue) => `from-default:${defaultValue}`);
            (0, chai_1.expect)(localized).to.deep.equal({ displayName: 'from-default:Default value' });
        });
    });
    describe('loadPackageTranslations', () => {
        let pluginRoot;
        beforeEach(async () => {
            pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'package-nls-load-'));
        });
        afterEach(async () => {
            await fs.remove(pluginRoot);
        });
        it('returns an empty object when package.nls.json is missing', async () => {
            (0, chai_1.expect)(await (0, package_nls_2.loadPackageTranslations)(pluginRoot)).to.deep.equal({});
        });
        it('loads the default bundle without a locale', async () => {
            await fs.writeJson(path.join(pluginRoot, 'package.nls.json'), { 'display.name': 'Sample' });
            (0, chai_1.expect)(await (0, package_nls_2.loadPackageTranslations)(pluginRoot)).to.deep.equal({
                default: { 'display.name': 'Sample' }
            });
        });
        it('loads locale-specific translations when present', async () => {
            await fs.writeJson(path.join(pluginRoot, 'package.nls.json'), { 'display.name': 'Sample' });
            await fs.writeJson(path.join(pluginRoot, 'package.nls.de.json'), { 'display.name': 'Beispiel' });
            (0, chai_1.expect)(await (0, package_nls_2.loadPackageTranslations)(pluginRoot, 'de')).to.deep.equal({
                default: { 'display.name': 'Sample' },
                translation: { 'display.name': 'Beispiel' }
            });
        });
    });
});
//# sourceMappingURL=package-nls.spec.js.map