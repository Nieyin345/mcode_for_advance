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
const assert_1 = require("assert");
const fs_1 = require("fs");
const utils_1 = require("./utils");
describe('utils', () => {
    describe('isObject', () => {
        it('returns true for plain objects', () => {
            (0, chai_1.expect)((0, utils_1.isObject)({})).to.equal(true);
            (0, chai_1.expect)((0, utils_1.isObject)({ a: 1 })).to.equal(true);
        });
        it('returns false for null and primitives', () => {
            // eslint-disable-next-line no-null/no-null
            (0, chai_1.expect)((0, utils_1.isObject)(null)).to.equal(false);
            (0, chai_1.expect)((0, utils_1.isObject)(undefined)).to.equal(false);
            (0, chai_1.expect)((0, utils_1.isObject)('x')).to.equal(false);
        });
        it('returns true for arrays because they are objects in JavaScript', () => {
            (0, chai_1.expect)((0, utils_1.isObject)([])).to.equal(true);
        });
    });
    describe('isStringArray', () => {
        it('returns true only for string arrays', () => {
            (0, chai_1.expect)((0, utils_1.isStringArray)(['a', 'b'])).to.equal(true);
            (0, chai_1.expect)((0, utils_1.isStringArray)([])).to.equal(true);
        });
        it('returns false for mixed or non-array values', () => {
            (0, chai_1.expect)((0, utils_1.isStringArray)(['a', 1])).to.equal(false);
            (0, chai_1.expect)((0, utils_1.isStringArray)('a')).to.equal(false);
        });
    });
    describe('isENOENT', () => {
        it('detects fs ENOENT errors', async () => {
            await (0, assert_1.rejects)(fs_1.promises.readFile('definitely-missing-' + Date.now()), reason => (0, utils_1.isENOENT)(reason));
        });
        it('returns false for plain errors and null', () => {
            (0, chai_1.expect)((0, utils_1.isENOENT)(new Error('I am not ENOENT'))).to.equal(false);
            // eslint-disable-next-line no-null/no-null
            (0, chai_1.expect)((0, utils_1.isENOENT)(null)).to.equal(false);
        });
        it('returns false for other errno codes', async () => {
            await (0, assert_1.rejects)(fs_1.promises.readdir(__filename), reason => !(0, utils_1.isENOENT)(reason));
        });
    });
    describe('deepClone', () => {
        it('clones nested objects without sharing references', () => {
            const source = { nested: { value: 1 }, list: [1, 2] };
            const clone = (0, utils_1.deepClone)(source);
            (0, chai_1.expect)(clone).to.deep.equal(source);
            (0, chai_1.expect)(clone).to.not.equal(source);
            (0, chai_1.expect)(clone.nested).to.not.equal(source.nested);
            (0, chai_1.expect)(clone.list).to.not.equal(source.list);
        });
        it('returns primitives and regexps unchanged', () => {
            (0, chai_1.expect)((0, utils_1.deepClone)(42)).to.equal(42);
            const re = /abc/;
            (0, chai_1.expect)((0, utils_1.deepClone)(re)).to.equal(re);
        });
    });
});
//# sourceMappingURL=utils.spec.js.map