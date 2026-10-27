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
const read_grammars_1 = require("./read-grammars");
describe('readGrammarFromDisk', () => {
    let pluginRoot;
    beforeEach(async () => {
        pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'read-grammars-'));
    });
    afterEach(async () => {
        await fs.remove(pluginRoot);
    });
    it('inlines JSON grammar file content', async () => {
        await fs.writeJson(path.join(pluginRoot, 'sample.tmLanguage.json'), { scopeName: 'source.sample' });
        const grammar = await (0, read_grammars_1.readGrammarFromDisk)({
            language: 'sample',
            scopeName: 'source.sample',
            path: './sample.tmLanguage.json'
        }, pluginRoot);
        (0, chai_1.expect)(grammar).to.deep.equal({
            language: 'sample',
            scope: 'source.sample',
            format: 'json',
            grammar: { scopeName: 'source.sample' },
            grammarLocation: './sample.tmLanguage.json',
            injectTo: undefined,
            embeddedLanguages: undefined,
            tokenTypes: undefined,
            balancedBracketScopes: undefined,
            unbalancedBracketScopes: undefined
        });
    });
    it('passes through balanced and unbalanced bracket scopes', async () => {
        await fs.writeJson(path.join(pluginRoot, 'sample.tmLanguage.json'), { scopeName: 'source.sample' });
        const grammar = await (0, read_grammars_1.readGrammarFromDisk)({
            language: 'sample',
            scopeName: 'source.sample',
            path: './sample.tmLanguage.json',
            balancedBracketScopes: ['*'],
            unbalancedBracketScopes: ['meta.template.expression']
        }, pluginRoot);
        (0, chai_1.expect)(grammar.balancedBracketScopes).to.deep.equal(['*']);
        (0, chai_1.expect)(grammar.unbalancedBracketScopes).to.deep.equal(['meta.template.expression']);
    });
    it('reads plist grammar files as text', async () => {
        const plist = '<?xml version="1.0"?><plist/>';
        await fs.writeFile(path.join(pluginRoot, 'sample.tmLanguage'), plist);
        const grammar = await (0, read_grammars_1.readGrammarFromDisk)({
            scopeName: 'source.sample',
            path: './sample.tmLanguage'
        }, pluginRoot);
        (0, chai_1.expect)(grammar.format).to.equal('plist');
        (0, chai_1.expect)(grammar.grammar).to.equal(plist);
    });
    it('returns undefined for invalid manifest fields and reports via onError', async () => {
        await fs.writeJson(path.join(pluginRoot, 'sample.tmLanguage.json'), { scopeName: 'source.sample' });
        const errors = [];
        const onError = (type, err) => { errors.push({ type, err }); };
        (0, chai_1.expect)(await (0, read_grammars_1.readGrammarFromDisk)({
            scopeName: '',
            path: './sample.tmLanguage.json'
        }, pluginRoot, { onError })).to.equal(undefined);
        (0, chai_1.expect)(await (0, read_grammars_1.readGrammarFromDisk)({
            scopeName: 'source.sample',
            path: ''
        }, pluginRoot, { onError })).to.equal(undefined);
        (0, chai_1.expect)(await (0, read_grammars_1.readGrammarFromDisk)({
            scopeName: 'source.sample',
            path: './sample.tmLanguage.json',
            injectTo: 'text.html.basic'
        }, pluginRoot, { onError })).to.equal(undefined);
        (0, chai_1.expect)(errors).to.have.length(3);
        (0, chai_1.expect)(errors.every(e => e.type === 'grammars')).to.equal(true);
        (0, chai_1.expect)(String(errors[0].err)).to.contain('scopeName');
        (0, chai_1.expect)(String(errors[1].err)).to.contain('path');
        (0, chai_1.expect)(String(errors[2].err)).to.contain('injectTo');
    });
    it('rejects grammar paths outside the plugin directory with onError', async () => {
        (0, chai_1.expect)((0, read_grammars_1.getGrammarContributionValidationError)({
            scopeName: 'source.sample',
            path: '../outside.tmLanguage.json'
        }, pluginRoot)).to.contain('escapes the plugin directory');
        const errors = [];
        (0, chai_1.expect)(await (0, read_grammars_1.readGrammarFromDisk)({
            scopeName: 'source.sample',
            path: '../outside.tmLanguage.json'
        }, pluginRoot, { onError: (_type, err) => errors.push(err) })).to.equal(undefined);
        (0, chai_1.expect)(String(errors[0])).to.contain('escapes the plugin directory');
    });
});
//# sourceMappingURL=read-grammars.spec.js.map