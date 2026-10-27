"use strict";
// *****************************************************************************
// Copyright (C) 2026 Matthew Farrow and others.
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
const textmate_tokenizer_1 = require("./textmate-tokenizer");
describe('createTextmateTokenizer', () => {
    // A grammar that hands back the rule stack it was given, so the tests only observe
    // what the tokenizer itself does with the state.
    const grammar = {
        tokenizeLine: (line, ruleStack) => ({ tokens: [], ruleStack }),
        tokenizeLine2: (line, ruleStack) => ({ tokens: new Uint32Array(), ruleStack })
    };
    const tokenizer = (0, textmate_tokenizer_1.createTextmateTokenizer)(grammar, { lineLimit: 8 });
    const longLine = 'x'.repeat(16);
    // Monaco stores the end state and passes it into the next line. Returning anything
    // other than a `TokenizerState` breaks the line after the skipped one: a short line
    // silently restarts the grammar, and a second skipped line returns `undefined`,
    // which Monaco rejects with 'Cannot set null/undefined state', stopping tokenization
    // for the whole model.
    it('should keep the state when tokenizeEncoded skips a line over the limit', () => {
        const state = tokenizer.getInitialState();
        const { endState } = tokenizer.tokenizeEncoded(longLine, state);
        (0, chai_1.expect)(endState).to.be.an.instanceOf(textmate_tokenizer_1.TokenizerState);
        (0, chai_1.expect)(endState).to.equal(state);
    });
    it('should keep the state when tokenize skips a line over the limit', () => {
        const state = tokenizer.getInitialState();
        const { endState } = tokenizer.tokenize(longLine, state);
        (0, chai_1.expect)(endState).to.be.an.instanceOf(textmate_tokenizer_1.TokenizerState);
        (0, chai_1.expect)(endState).to.equal(state);
    });
    it('should tokenize the line after a skipped one from the same state', () => {
        const initial = tokenizer.getInitialState();
        const afterSkipped = tokenizer.tokenizeEncoded(longLine, initial).endState;
        // Two skipped lines in a row is where the broken state surfaced as an exception.
        const afterSecondSkipped = tokenizer.tokenizeEncoded(longLine, afterSkipped).endState;
        (0, chai_1.expect)(afterSecondSkipped).to.be.an.instanceOf(textmate_tokenizer_1.TokenizerState);
        const { endState } = tokenizer.tokenizeEncoded('short', afterSecondSkipped);
        (0, chai_1.expect)(endState).to.be.an.instanceOf(textmate_tokenizer_1.TokenizerState);
        (0, chai_1.expect)(endState.stateStack).to.equal(initial.stateStack);
    });
});
//# sourceMappingURL=textmate-tokenizer.spec.js.map