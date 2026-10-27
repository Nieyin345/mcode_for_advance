"use strict";
// *****************************************************************************
// Copyright (C) 2023 EclipseSource and others.
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
const preference_provider_1 = require("./preference-provider");
const { expect } = require('chai');
describe('PreferenceProviderImpl', () => {
    it('should preserve extra source fields on merge', () => {
        const result = preference_provider_1.PreferenceUtils.merge({ 'configurations': [], 'compounds': [] }, { 'configurations': [] });
        expect(result).deep.equals({ 'configurations': [], 'compounds': [] });
    });
    it('should preserve extra target fields on merge', () => {
        const result = preference_provider_1.PreferenceUtils.merge({ 'configurations': [] }, { 'configurations': [], 'compounds': [] });
        expect(result).deep.equals({ 'configurations': [], 'compounds': [] });
    });
    it('should merge array values', () => {
        const result = preference_provider_1.PreferenceUtils.merge({ 'configurations': [{ 'name': 'test1', 'request': 'launch' }], 'compounds': [] }, { 'configurations': [{ 'name': 'test2' }] });
        expect(result).deep.equals({ 'configurations': [{ 'name': 'test1', 'request': 'launch' }, { 'name': 'test2' }], 'compounds': [] });
    });
    it('should ignore reserved keys when merging', () => {
        const payload = JSON.parse('{"__proto__":{"injected":"yes"}}');
        const result = preference_provider_1.PreferenceUtils.merge({ 'safe': true }, payload);
        // A modified Object.prototype leaks onto every object, so a freshly created `{}`
        // must not inherit the injected key and the result must stay a plain object.
        expect({}.injected).to.equal(undefined);
        expect(Object.getPrototypeOf(result)).to.equal(Object.prototype);
        expect(result).deep.equals({ 'safe': true });
    });
    it('should ignore nested reserved keys when merging', () => {
        const payload = JSON.parse('{"parent":{"__proto__":{"injected":"yes"},"valid":"true"}}');
        const result = preference_provider_1.PreferenceUtils.merge({ 'parent': { 'existing': true } }, payload);
        // The nested reserved key is dropped while the sibling `valid` is still merged, and a
        // freshly created `{}` must not inherit the injected key.
        expect({}.injected).to.equal(undefined);
        expect(result).deep.equals({ 'parent': { 'existing': true, 'valid': 'true' } });
    });
});
//# sourceMappingURL=preference-provider.spec.js.map