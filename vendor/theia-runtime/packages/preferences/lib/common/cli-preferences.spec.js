"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource GmbH and others.
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
const cli_preferences_1 = require("./cli-preferences");
describe('CliPreferenceEntry.parse', () => {
    it('parses a KEY=JSONVALUE assignment', () => {
        (0, chai_1.expect)(cli_preferences_1.CliPreferenceEntry.parse('editor.fontSize=14')).to.deep.equal(['editor.fontSize', 14]);
    });
    it('parses boolean and string JSON values', () => {
        (0, chai_1.expect)(cli_preferences_1.CliPreferenceEntry.parse('foo.enabled=true')).to.deep.equal(['foo.enabled', true]);
        (0, chai_1.expect)(cli_preferences_1.CliPreferenceEntry.parse('foo.label="hello"')).to.deep.equal(['foo.label', 'hello']);
    });
    it('keeps "=" characters that are part of the value', () => {
        (0, chai_1.expect)(cli_preferences_1.CliPreferenceEntry.parse('foo.expr="a=b"')).to.deep.equal(['foo.expr', 'a=b']);
    });
    it('decodes a base64-encoded value', () => {
        // base64 of the JSON value `42`
        (0, chai_1.expect)(cli_preferences_1.CliPreferenceEntry.parse('foo.num=base64:NDI=')).to.deep.equal(['foo.num', 42]);
    });
    it('returns undefined when there is no key', () => {
        (0, chai_1.expect)(cli_preferences_1.CliPreferenceEntry.parse('=1')).to.be.undefined;
    });
    it('returns undefined when there is no "="', () => {
        (0, chai_1.expect)(cli_preferences_1.CliPreferenceEntry.parse('noequals')).to.be.undefined;
    });
    it('returns undefined for an invalid JSON value', () => {
        (0, chai_1.expect)(cli_preferences_1.CliPreferenceEntry.parse('foo.bar=not json')).to.be.undefined;
    });
    describe('parseAll', () => {
        it('parses and filters a list, dropping invalid entries', () => {
            const result = cli_preferences_1.CliPreferenceEntry.parseAll(['a=1', 'bad', 'b="x"']);
            (0, chai_1.expect)(result).to.deep.equal([['a', 1], ['b', 'x']]);
        });
    });
    describe('toArg', () => {
        it('formats an entry as a base64-encoded CLI argument', () => {
            // base64 of the JSON value `42`
            (0, chai_1.expect)(cli_preferences_1.CliPreferenceEntry.toArg('session-preference', ['foo.num', 42])).to.equal('--session-preference=foo.num=base64:NDI=');
        });
        it('round-trips a value with shell-special characters through toArg + parse', () => {
            const entry = ['foo.expr', '$HOME && "quoted"'];
            const arg = cli_preferences_1.CliPreferenceEntry.toArg('session-preference', entry);
            // The value part of `--session-preference=<value>` must parse back to the original entry.
            const value = arg.substring('--session-preference='.length);
            (0, chai_1.expect)(cli_preferences_1.CliPreferenceEntry.parse(value)).to.deep.equal(entry);
        });
    });
});
//# sourceMappingURL=cli-preferences.spec.js.map