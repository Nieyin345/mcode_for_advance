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
const ternary_search_tree_1 = require("./ternary-search-tree");
const keys_1 = require("./keys");
describe('KeySequenceIterator', () => {
    let iterator;
    beforeEach(() => {
        iterator = new ternary_search_tree_1.KeySequenceIterator();
    });
    it('should reset and iterate over a single key sequence', () => {
        const keySequence = [
            keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_A, modifiers: [keys_1.KeyModifier.CtrlCmd] })
        ];
        iterator.reset(keySequence);
        (0, chai_1.expect)(iterator.value()).to.not.be.empty;
        (0, chai_1.expect)(iterator.hasNext()).to.be.false;
    });
    it('should iterate over a multi-key sequence (chord)', () => {
        const keySequence = [
            keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_K, modifiers: [keys_1.KeyModifier.CtrlCmd] }),
            keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_C, modifiers: [keys_1.KeyModifier.CtrlCmd] })
        ];
        iterator.reset(keySequence);
        (0, chai_1.expect)(iterator.hasNext()).to.be.true;
        const firstValue = iterator.value();
        (0, chai_1.expect)(firstValue).to.not.be.empty;
        iterator.next();
        (0, chai_1.expect)(iterator.hasNext()).to.be.false;
        const secondValue = iterator.value();
        (0, chai_1.expect)(secondValue).to.not.be.empty;
        (0, chai_1.expect)(secondValue).to.not.equal(firstValue);
    });
    it('should compare correctly with cmp()', () => {
        const keySequence = [
            keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_A, modifiers: [keys_1.KeyModifier.CtrlCmd] })
        ];
        iterator.reset(keySequence);
        const currentValue = iterator.value();
        // Same value should return 0
        (0, chai_1.expect)(iterator.cmp(currentValue)).to.equal(0);
        // Different value should return non-zero
        (0, chai_1.expect)(iterator.cmp('different')).to.not.equal(0);
    });
});
describe('TernarySearchTree for KeySequences', () => {
    let tree;
    beforeEach(() => {
        tree = ternary_search_tree_1.TernarySearchTree.forKeySequences();
    });
    it('should store and retrieve a single keybinding', () => {
        const keySequence = [
            keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_A, modifiers: [keys_1.KeyModifier.CtrlCmd] })
        ];
        tree.set(keySequence, 'command.a');
        (0, chai_1.expect)(tree.get(keySequence)).to.equal('command.a');
    });
    it('should store and retrieve multiple keybindings', () => {
        const keySequenceA = [
            keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_A, modifiers: [keys_1.KeyModifier.CtrlCmd] })
        ];
        const keySequenceB = [
            keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_B, modifiers: [keys_1.KeyModifier.CtrlCmd] })
        ];
        tree.set(keySequenceA, 'command.a');
        tree.set(keySequenceB, 'command.b');
        (0, chai_1.expect)(tree.get(keySequenceA)).to.equal('command.a');
        (0, chai_1.expect)(tree.get(keySequenceB)).to.equal('command.b');
    });
    it('should store and retrieve chord keybindings', () => {
        const chordSequence = [
            keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_K, modifiers: [keys_1.KeyModifier.CtrlCmd] }),
            keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_C, modifiers: [keys_1.KeyModifier.CtrlCmd] })
        ];
        tree.set(chordSequence, 'command.chord');
        (0, chai_1.expect)(tree.get(chordSequence)).to.equal('command.chord');
    });
    it('should return undefined for non-existent keybindings', () => {
        const keySequence = [
            keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_X, modifiers: [keys_1.KeyModifier.CtrlCmd] })
        ];
        (0, chai_1.expect)(tree.get(keySequence)).to.be.undefined;
    });
    it('should find superstrings (partial matches for chords)', () => {
        const prefixSequence = [
            keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_K, modifiers: [keys_1.KeyModifier.CtrlCmd] })
        ];
        const chordSequence1 = [
            keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_K, modifiers: [keys_1.KeyModifier.CtrlCmd] }),
            keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_C })
        ];
        const chordSequence2 = [
            keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_K, modifiers: [keys_1.KeyModifier.CtrlCmd] }),
            keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_D })
        ];
        tree.set(chordSequence1, 'command.kc');
        tree.set(chordSequence2, 'command.kd');
        // The prefix should find both chords as superstrings
        const superstrIterator = tree.findSuperstr(prefixSequence);
        (0, chai_1.expect)(superstrIterator).to.not.be.undefined;
        const results = [];
        if (superstrIterator) {
            let result = superstrIterator.next();
            while (!result.done) {
                results.push(result.value);
                result = superstrIterator.next();
            }
        }
        (0, chai_1.expect)(results).to.include('command.kc');
        (0, chai_1.expect)(results).to.include('command.kd');
    });
    it('should not find superstrings when none exist', () => {
        const keySequenceA = [
            keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_A, modifiers: [keys_1.KeyModifier.CtrlCmd] })
        ];
        const searchSequence = [
            keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_B, modifiers: [keys_1.KeyModifier.CtrlCmd] })
        ];
        tree.set(keySequenceA, 'command.a');
        const superstrIterator = tree.findSuperstr(searchSequence);
        (0, chai_1.expect)(superstrIterator).to.be.undefined;
    });
    it('should delete keybindings', () => {
        const keySequence = [
            keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_A, modifiers: [keys_1.KeyModifier.CtrlCmd] })
        ];
        tree.set(keySequence, 'command.a');
        (0, chai_1.expect)(tree.get(keySequence)).to.equal('command.a');
        tree.delete(keySequence);
        (0, chai_1.expect)(tree.get(keySequence)).to.be.undefined;
    });
    it('should clear all keybindings', () => {
        const keySequenceA = [
            keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_A, modifiers: [keys_1.KeyModifier.CtrlCmd] })
        ];
        const keySequenceB = [
            keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_B, modifiers: [keys_1.KeyModifier.CtrlCmd] })
        ];
        tree.set(keySequenceA, 'command.a');
        tree.set(keySequenceB, 'command.b');
        tree.clear();
        (0, chai_1.expect)(tree.get(keySequenceA)).to.be.undefined;
        (0, chai_1.expect)(tree.get(keySequenceB)).to.be.undefined;
    });
    it('should update existing keybinding value', () => {
        const keySequence = [
            keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_A, modifiers: [keys_1.KeyModifier.CtrlCmd] })
        ];
        tree.set(keySequence, 'command.original');
        (0, chai_1.expect)(tree.get(keySequence)).to.equal('command.original');
        tree.set(keySequence, 'command.updated');
        (0, chai_1.expect)(tree.get(keySequence)).to.equal('command.updated');
    });
    it('should iterate over all keybindings with forEach', () => {
        const keySequenceA = [
            keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_A, modifiers: [keys_1.KeyModifier.CtrlCmd] })
        ];
        const keySequenceB = [
            keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_B, modifiers: [keys_1.KeyModifier.CtrlCmd] })
        ];
        tree.set(keySequenceA, 'command.a');
        tree.set(keySequenceB, 'command.b');
        const results = [];
        tree.forEach(value => {
            results.push(value);
        });
        (0, chai_1.expect)(results).to.have.lengthOf(2);
        (0, chai_1.expect)(results).to.include('command.a');
        (0, chai_1.expect)(results).to.include('command.b');
    });
    it('should handle keybindings with different modifiers', () => {
        const ctrlA = [
            keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_A, modifiers: [keys_1.KeyModifier.CtrlCmd] })
        ];
        const shiftA = [
            keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_A, modifiers: [keys_1.KeyModifier.Shift] })
        ];
        const altA = [
            keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_A, modifiers: [keys_1.KeyModifier.Alt] })
        ];
        tree.set(ctrlA, 'command.ctrl.a');
        tree.set(shiftA, 'command.shift.a');
        tree.set(altA, 'command.alt.a');
        (0, chai_1.expect)(tree.get(ctrlA)).to.equal('command.ctrl.a');
        (0, chai_1.expect)(tree.get(shiftA)).to.equal('command.shift.a');
        (0, chai_1.expect)(tree.get(altA)).to.equal('command.alt.a');
    });
    it('should store arrays of bindings for the same key sequence', () => {
        const keySequence = [
            keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_A, modifiers: [keys_1.KeyModifier.CtrlCmd] })
        ];
        const bindings = ['command.a1', 'command.a2', 'command.a3'];
        const arrayTree = ternary_search_tree_1.TernarySearchTree.forKeySequences();
        arrayTree.set(keySequence, bindings);
        const result = arrayTree.get(keySequence);
        (0, chai_1.expect)(result).to.deep.equal(bindings);
        (0, chai_1.expect)(result).to.have.lengthOf(3);
    });
});
//# sourceMappingURL=ternary-search-tree.spec.js.map