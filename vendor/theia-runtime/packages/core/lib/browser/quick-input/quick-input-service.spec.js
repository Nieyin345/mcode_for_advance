"use strict";
// *****************************************************************************
// Copyright (C) 2021 Ericsson and others.
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
const chai = require("chai");
const quick_input_service_1 = require("./quick-input-service");
const expect = chai.expect;
describe('quick-input-service', () => {
    describe('#findMatches', () => {
        it('should return a single contiguous range for substring matches', () => {
            expect((0, quick_input_service_1.findMatches)('abc', 'a')).deep.equal([{ start: 0, end: 1 }]);
            expect((0, quick_input_service_1.findMatches)('abc', 'ab')).deep.equal([{ start: 0, end: 2 }]);
            expect((0, quick_input_service_1.findMatches)('abc', 'abc')).deep.equal([{ start: 0, end: 3 }]);
        });
        it('should return per-character ranges for fuzzy-only matches', () => {
            expect((0, quick_input_service_1.findMatches)('abc', 'ac')).deep.equal([{ start: 0, end: 1 }, { start: 2, end: 3 }]);
        });
        it('should fail when out of order', () => {
            expect((0, quick_input_service_1.findMatches)('abc', 'ba')).equal(undefined);
        });
        it('should return `undefined` when no matches are found', () => {
            expect((0, quick_input_service_1.findMatches)('abc', 'f')).equal(undefined);
        });
        it('should return `undefined` when no filter is present', () => {
            expect((0, quick_input_service_1.findMatches)('abc', '')).equal(undefined);
        });
    });
    describe('#filterItems', () => {
        let items = [];
        beforeEach(() => {
            items = [
                { label: 'a' },
                { label: 'abc', description: 'v' },
                { label: 'def', description: 'd', detail: 'y' },
                { label: 'z', description: 'z', detail: 'z' }
            ];
        });
        it('should return the full list when no filter is present', () => {
            const result = (0, quick_input_service_1.filterItems)(items, '');
            expect(result).deep.equal(items);
        });
        it('should filter items based on the label', () => {
            const expectation = {
                label: 'abc',
                highlights: {
                    label: [
                        { start: 0, end: 3 }
                    ]
                }
            };
            const result = (0, quick_input_service_1.filterItems)(items, 'abc').filter(quick_input_service_1.QuickPickItem.is);
            expect(result).length(1);
            expect(result[0].label).equal(expectation.label);
            expect(result[0].highlights?.label).deep.equal(expectation.highlights?.label);
        });
        it('should filter items based on `description` if `label` does not match', () => {
            const expectation = {
                label: 'abc',
                description: 'v',
                highlights: {
                    description: [
                        { start: 0, end: 1 }
                    ]
                }
            };
            const result = (0, quick_input_service_1.filterItems)(items, 'v').filter(quick_input_service_1.QuickPickItem.is);
            expect(result).length(1);
            expect(result[0].label).equal(expectation.label);
            expect(result[0].description).equal(expectation.description);
            expect(result[0].highlights?.label).equal(undefined);
            expect(result[0].highlights?.description).deep.equal(expectation.highlights?.description);
        });
        it('should filter items based on `detail` if `label` and `description` does not match', () => {
            const expectation = {
                label: 'def',
                description: 'd',
                detail: 'y',
                highlights: {
                    detail: [
                        { start: 0, end: 1 }
                    ]
                }
            };
            const result = (0, quick_input_service_1.filterItems)(items, 'y').filter(quick_input_service_1.QuickPickItem.is);
            expect(result).length(1);
            expect(result[0].label).equal(expectation.label);
            expect(result[0].description).equal(expectation.description);
            expect(result[0].detail).equal(expectation.detail);
            expect(result[0].highlights?.label).equal(undefined);
            expect(result[0].highlights?.description).equal(undefined);
            expect(result[0].highlights?.detail).deep.equal(expectation.highlights?.detail);
        });
        it('should return multiple highlights if it matches multiple properties', () => {
            const expectation = {
                label: 'z',
                description: 'z',
                detail: 'z',
                highlights: {
                    label: [
                        { start: 0, end: 1 }
                    ],
                    description: [
                        { start: 0, end: 1 }
                    ],
                    detail: [
                        { start: 0, end: 1 }
                    ]
                }
            };
            const result = (0, quick_input_service_1.filterItems)(items, 'z').filter(quick_input_service_1.QuickPickItem.is);
            expect(result).length(1);
            expect(result[0].label).equal(expectation.label);
            expect(result[0].description).equal(expectation.description);
            expect(result[0].detail).equal(expectation.detail);
            expect(result[0].highlights?.label).deep.equal(expectation.highlights?.label);
            expect(result[0].highlights?.description).deep.equal(expectation.highlights?.description);
            expect(result[0].highlights?.detail).deep.equal(expectation.highlights?.detail);
        });
        it('should reset highlights upon subsequent searches', () => {
            const expectation = {
                label: 'abc',
                highlights: {
                    label: [
                        { start: 0, end: 3 }
                    ]
                }
            };
            let result = (0, quick_input_service_1.filterItems)(items, 'abc').filter(quick_input_service_1.QuickPickItem.is);
            expect(result).length(1);
            expect(result[0].label).equal(expectation.label);
            expect(result[0].highlights?.label).deep.equal(expectation.highlights?.label);
            result = (0, quick_input_service_1.filterItems)(items, '').filter(quick_input_service_1.QuickPickItem.is);
            expect(result[0].highlights?.label).equal(undefined);
        });
        it('should return an empty list when no matches are found', () => {
            expect((0, quick_input_service_1.filterItems)(items, 'yyy')).deep.equal([]);
        });
        it('should rank substring matches before fuzzy-only matches', () => {
            const testItems = [
                { label: 'reformatting' },
                { label: 'fontSize' },
                { label: 'fontFamily' },
            ];
            const result = (0, quick_input_service_1.filterItems)(testItems, 'font').filter(quick_input_service_1.QuickPickItem.is);
            expect(result).length(2);
            expect(result[0].label).equal('fontSize');
            expect(result[1].label).equal('fontFamily');
        });
        it('should rank prefix matches before other substring matches', () => {
            const testItems = [
                { label: 'setFont' },
                { label: 'fontSize' },
                { label: 'fontFamily' },
            ];
            const result = (0, quick_input_service_1.filterItems)(testItems, 'font').filter(quick_input_service_1.QuickPickItem.is);
            expect(result).length(3);
            expect(result[0].label).equal('fontSize');
            expect(result[1].label).equal('fontFamily');
            expect(result[2].label).equal('setFont');
        });
        it('should treat segmented prefix matches as prefix matches', () => {
            const testItems = [
                { label: 'backend-workspace-service.ts' },
                { label: 'workspace-backend-service.ts' },
            ];
            const result = (0, quick_input_service_1.filterItems)(testItems, 'works-ser').filter(quick_input_service_1.QuickPickItem.is);
            expect(result).length(2);
            expect(result[0].label).equal('workspace-backend-service.ts');
            expect(result[1].label).equal('backend-workspace-service.ts');
        });
        it('should drop separators when their group has no matches', () => {
            const testItems = [
                { type: 'separator', label: 'Group A' },
                { label: 'fontSize' },
                { type: 'separator', label: 'Group B' },
                { label: 'xyz' },
            ];
            const result = (0, quick_input_service_1.filterItems)(testItems, 'font');
            // Group B's only item "xyz" doesn't match, so Group B separator is dropped
            expect(result).length(2);
            expect(result[0]).to.have.property('type', 'separator');
            expect(result[1]).to.have.property('label', 'fontSize');
        });
    });
});
//# sourceMappingURL=quick-input-service.spec.js.map