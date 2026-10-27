"use strict";
// *****************************************************************************
// Copyright (C) 2025 TypeFox and others.
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
const output_ansi_parser_1 = require("./output-ansi-parser");
describe('Output ANSI Parser', () => {
    it('should return plain text unchanged', () => {
        const result = (0, output_ansi_parser_1.parseAnsi)('hello world');
        (0, chai_1.expect)(result.strippedText).to.equal('hello world');
        (0, chai_1.expect)(result.segments).to.be.empty;
    });
    it('should strip ANSI codes and return stripped text', () => {
        const result = (0, output_ansi_parser_1.parseAnsi)('\x1b[31mhello\x1b[0m world');
        (0, chai_1.expect)(result.strippedText).to.equal('hello world');
    });
    it('should produce a segment for foreground color', () => {
        const result = (0, output_ansi_parser_1.parseAnsi)('\x1b[31mred text\x1b[0m');
        (0, chai_1.expect)(result.strippedText).to.equal('red text');
        (0, chai_1.expect)(result.segments).to.have.length(1);
        (0, chai_1.expect)(result.segments[0]).to.deep.equal({
            start: 0,
            end: 8,
            cssClasses: 'ansi-red-fg'
        });
    });
    it('should handle multiple colors', () => {
        const result = (0, output_ansi_parser_1.parseAnsi)('\x1b[31mred\x1b[32mgreen\x1b[0m');
        (0, chai_1.expect)(result.strippedText).to.equal('redgreen');
        (0, chai_1.expect)(result.segments).to.have.length(2);
        (0, chai_1.expect)(result.segments[0]).to.deep.equal({ start: 0, end: 3, cssClasses: 'ansi-red-fg' });
        (0, chai_1.expect)(result.segments[1]).to.deep.equal({ start: 3, end: 8, cssClasses: 'ansi-green-fg' });
    });
    it('should handle bright foreground colors', () => {
        const result = (0, output_ansi_parser_1.parseAnsi)('\x1b[91mbright red\x1b[0m');
        (0, chai_1.expect)(result.strippedText).to.equal('bright red');
        (0, chai_1.expect)(result.segments).to.have.length(1);
        (0, chai_1.expect)(result.segments[0].cssClasses).to.equal('ansi-bright-red-fg');
    });
    it('should handle background colors', () => {
        const result = (0, output_ansi_parser_1.parseAnsi)('\x1b[41mred bg\x1b[0m');
        (0, chai_1.expect)(result.strippedText).to.equal('red bg');
        (0, chai_1.expect)(result.segments).to.have.length(1);
        (0, chai_1.expect)(result.segments[0].cssClasses).to.equal('ansi-red-bg');
    });
    it('should handle combined foreground and background', () => {
        const result = (0, output_ansi_parser_1.parseAnsi)('\x1b[31;42mred on green\x1b[0m');
        (0, chai_1.expect)(result.strippedText).to.equal('red on green');
        (0, chai_1.expect)(result.segments).to.have.length(1);
        (0, chai_1.expect)(result.segments[0].cssClasses).to.equal('ansi-red-fg ansi-green-bg');
    });
    it('should handle bold, italic, and underline', () => {
        const result = (0, output_ansi_parser_1.parseAnsi)('\x1b[1mbold\x1b[0m \x1b[3mitalic\x1b[0m \x1b[4munderline\x1b[0m');
        (0, chai_1.expect)(result.strippedText).to.equal('bold italic underline');
        (0, chai_1.expect)(result.segments).to.have.length(3);
        (0, chai_1.expect)(result.segments[0].cssClasses).to.equal('ansi-bold');
        (0, chai_1.expect)(result.segments[1].cssClasses).to.equal('ansi-italic');
        (0, chai_1.expect)(result.segments[2].cssClasses).to.equal('ansi-underline');
    });
    it('should handle combined styles with color', () => {
        const result = (0, output_ansi_parser_1.parseAnsi)('\x1b[1;31mbold red\x1b[0m');
        (0, chai_1.expect)(result.strippedText).to.equal('bold red');
        (0, chai_1.expect)(result.segments).to.have.length(1);
        (0, chai_1.expect)(result.segments[0].cssClasses).to.equal('ansi-red-fg ansi-bold');
    });
    it('should handle empty escape sequence as reset', () => {
        const result = (0, output_ansi_parser_1.parseAnsi)('\x1b[31mred\x1b[mnormal');
        (0, chai_1.expect)(result.strippedText).to.equal('rednormal');
        (0, chai_1.expect)(result.segments).to.have.length(1);
        (0, chai_1.expect)(result.segments[0]).to.deep.equal({ start: 0, end: 3, cssClasses: 'ansi-red-fg' });
    });
    it('should preserve state across calls', () => {
        const result1 = (0, output_ansi_parser_1.parseAnsi)('\x1b[31m');
        (0, chai_1.expect)(result1.strippedText).to.equal('');
        (0, chai_1.expect)(result1.segments).to.be.empty;
        (0, chai_1.expect)(result1.state.foreground).to.equal('ansi-red-fg');
        const result2 = (0, output_ansi_parser_1.parseAnsi)('red text\x1b[0m', result1.state);
        (0, chai_1.expect)(result2.strippedText).to.equal('red text');
        (0, chai_1.expect)(result2.segments).to.have.length(1);
        (0, chai_1.expect)(result2.segments[0]).to.deep.equal({ start: 0, end: 8, cssClasses: 'ansi-red-fg' });
    });
    it('should handle text with no escape codes after initial state', () => {
        const result = (0, output_ansi_parser_1.parseAnsi)('still red', { foreground: 'ansi-red-fg' });
        (0, chai_1.expect)(result.strippedText).to.equal('still red');
        (0, chai_1.expect)(result.segments).to.have.length(1);
        (0, chai_1.expect)(result.segments[0]).to.deep.equal({ start: 0, end: 9, cssClasses: 'ansi-red-fg' });
    });
    it('should handle reset of individual attributes', () => {
        const result = (0, output_ansi_parser_1.parseAnsi)('\x1b[1;31mbold red\x1b[22mnot bold red\x1b[0m');
        (0, chai_1.expect)(result.strippedText).to.equal('bold rednot bold red');
        (0, chai_1.expect)(result.segments).to.have.length(2);
        (0, chai_1.expect)(result.segments[0].cssClasses).to.equal('ansi-red-fg ansi-bold');
        (0, chai_1.expect)(result.segments[1].cssClasses).to.equal('ansi-red-fg');
    });
    it('should handle text with newlines', () => {
        const result = (0, output_ansi_parser_1.parseAnsi)('\x1b[32mline1\nline2\x1b[0m');
        (0, chai_1.expect)(result.strippedText).to.equal('line1\nline2');
        (0, chai_1.expect)(result.segments).to.have.length(1);
        (0, chai_1.expect)(result.segments[0]).to.deep.equal({ start: 0, end: 11, cssClasses: 'ansi-green-fg' });
    });
    it('should handle text without any ANSI codes', () => {
        const result = (0, output_ansi_parser_1.parseAnsi)('plain text\nwith newlines');
        (0, chai_1.expect)(result.strippedText).to.equal('plain text\nwith newlines');
        (0, chai_1.expect)(result.segments).to.be.empty;
    });
    it('should handle default foreground reset (code 39)', () => {
        const result = (0, output_ansi_parser_1.parseAnsi)('\x1b[31mred\x1b[39mdefault');
        (0, chai_1.expect)(result.strippedText).to.equal('reddefault');
        (0, chai_1.expect)(result.segments).to.have.length(1);
        (0, chai_1.expect)(result.segments[0]).to.deep.equal({ start: 0, end: 3, cssClasses: 'ansi-red-fg' });
    });
    it('should handle all standard foreground colors', () => {
        const colors = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
        for (let i = 0; i < colors.length; i++) {
            const result = (0, output_ansi_parser_1.parseAnsi)(`\x1b[${30 + i}mx\x1b[0m`);
            (0, chai_1.expect)(result.segments[0].cssClasses).to.equal(`ansi-${colors[i]}-fg`);
        }
    });
    it('should handle all bright foreground colors', () => {
        const colors = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
        for (let i = 0; i < colors.length; i++) {
            const result = (0, output_ansi_parser_1.parseAnsi)(`\x1b[${90 + i}mx\x1b[0m`);
            (0, chai_1.expect)(result.segments[0].cssClasses).to.equal(`ansi-bright-${colors[i]}-fg`);
        }
    });
});
//# sourceMappingURL=output-ansi-parser.spec.js.map