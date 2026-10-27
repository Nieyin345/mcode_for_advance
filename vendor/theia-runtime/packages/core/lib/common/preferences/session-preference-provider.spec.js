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
const session_preference_provider_1 = require("./session-preference-provider");
const preference_scope_1 = require("./preference-scope");
describe('SessionPreferenceProvider', () => {
    let provider;
    beforeEach(() => {
        provider = new session_preference_provider_1.SessionPreferenceProvider();
        // PostConstruct emulation
        provider.init();
    });
    it('claims only the Session scope', () => {
        (0, chai_1.expect)(provider.canHandleScope(preference_scope_1.PreferenceScope.Session)).to.be.true;
        (0, chai_1.expect)(provider.canHandleScope(preference_scope_1.PreferenceScope.User)).to.be.false;
        (0, chai_1.expect)(provider.canHandleScope(preference_scope_1.PreferenceScope.Workspace)).to.be.false;
        (0, chai_1.expect)(provider.canHandleScope(preference_scope_1.PreferenceScope.Folder)).to.be.false;
        (0, chai_1.expect)(provider.canHandleScope(preference_scope_1.PreferenceScope.Default)).to.be.false;
    });
    it('starts empty', () => {
        (0, chai_1.expect)(provider.getPreferences()).to.deep.equal({});
    });
    it('stores set values in memory and exposes them via get/resolve', async () => {
        const ok = await provider.setPreference('editor.fontSize', 18);
        (0, chai_1.expect)(ok).to.be.true;
        (0, chai_1.expect)(provider.get('editor.fontSize')).to.equal(18);
        (0, chai_1.expect)(provider.resolve('editor.fontSize').value).to.equal(18);
        (0, chai_1.expect)(provider.getPreferences()).to.deep.equal({ 'editor.fontSize': 18 });
    });
    it('emits a change event on set', async () => {
        let received;
        provider.onDidPreferencesChanged(changes => {
            const key = Object.keys(changes)[0];
            received = {
                name: changes[key].preferenceName,
                newValue: changes[key].newValue,
                oldValue: changes[key].oldValue,
                scope: changes[key].scope
            };
        });
        await provider.setPreference('foo', 'bar');
        (0, chai_1.expect)(received).to.deep.equal({ name: 'foo', newValue: 'bar', oldValue: undefined, scope: preference_scope_1.PreferenceScope.Session });
    });
    it('removes a value when set to undefined', async () => {
        await provider.setPreference('foo', 'bar');
        const removed = await provider.setPreference('foo', undefined);
        (0, chai_1.expect)(removed).to.be.true;
        (0, chai_1.expect)(provider.get('foo')).to.equal(undefined);
        (0, chai_1.expect)(provider.getPreferences()).to.deep.equal({});
    });
    it('returns false when removing a key that was never set', async () => {
        const removed = await provider.setPreference('missing', undefined);
        (0, chai_1.expect)(removed).to.be.false;
    });
});
//# sourceMappingURL=session-preference-provider.spec.js.map