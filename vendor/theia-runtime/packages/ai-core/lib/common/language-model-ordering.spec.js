"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource GmbH.
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
const language_model_util_1 = require("./language-model-util");
function model(id, released, vendor) {
    return { id, released, vendor, status: { status: 'ready' } };
}
describe('compareModelsByRecency', () => {
    it('puts the most recently released model first', () => {
        const sorted = [
            model('anthropic/claude-haiku-4-5', Date.parse('2025-10-01')),
            model('anthropic/claude-opus-5', Date.parse('2026-04-01'))
        ].sort(language_model_util_1.compareModelsByRecency);
        (0, chai_1.expect)(sorted.map(entry => entry.id)).to.deep.equal(['anthropic/claude-opus-5', 'anthropic/claude-haiku-4-5']);
    });
    it('falls back to the id when no release date is reported, as for Gemini', () => {
        const sorted = [model('google/gemini-3.7-flash'), model('google/gemini-3.1-pro')].sort(language_model_util_1.compareModelsByRecency);
        (0, chai_1.expect)(sorted.map(entry => entry.id)).to.deep.equal(['google/gemini-3.1-pro', 'google/gemini-3.7-flash']);
    });
    it('sorts a model without a reported date after the dated ones rather than to the top', () => {
        const sorted = [
            model('openai/undated'),
            model('openai/dated', Date.parse('2020-01-01'))
        ].sort(language_model_util_1.compareModelsByRecency);
        (0, chai_1.expect)(sorted.map(entry => entry.id)).to.deep.equal(['openai/dated', 'openai/undated']);
    });
});
describe('providerOf', () => {
    it('prefers the declared vendor', () => {
        (0, chai_1.expect)((0, language_model_util_1.providerOf)(model('openai/gpt-5.5', undefined, 'openai'))).to.equal('openai');
    });
    it('falls back to the id prefix', () => {
        (0, chai_1.expect)((0, language_model_util_1.providerOf)(model('anthropic/claude-opus-5'))).to.equal('anthropic');
    });
    it('yields an empty provider for an unprefixed id, e.g. a custom endpoint', () => {
        (0, chai_1.expect)((0, language_model_util_1.providerOf)(model('my-local-model'))).to.equal('');
    });
});
describe('groupModelsByProvider', () => {
    it('groups by provider, ordering the groups by name and their models by recency', () => {
        const groups = (0, language_model_util_1.groupModelsByProvider)([
            model('openai/gpt-5.5', Date.parse('2025-08-01')),
            model('anthropic/claude-haiku-4-5', Date.parse('2025-10-01')),
            model('openai/gpt-5.6-sol', Date.parse('2026-02-01')),
            model('anthropic/claude-opus-5', Date.parse('2026-04-01'))
        ]);
        (0, chai_1.expect)(groups.map(group => group.provider)).to.deep.equal(['anthropic', 'openai']);
        (0, chai_1.expect)(groups[0].models.map(entry => entry.id)).to.deep.equal(['anthropic/claude-opus-5', 'anthropic/claude-haiku-4-5']);
        (0, chai_1.expect)(groups[1].models.map(entry => entry.id)).to.deep.equal(['openai/gpt-5.6-sol', 'openai/gpt-5.5']);
    });
    it('leaves the input untouched', () => {
        const models = [model('b/second'), model('a/first')];
        (0, language_model_util_1.groupModelsByProvider)(models);
        (0, chai_1.expect)(models.map(entry => entry.id)).to.deep.equal(['b/second', 'a/first']);
    });
});
//# sourceMappingURL=language-model-ordering.spec.js.map