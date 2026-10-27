"use strict";
// *****************************************************************************
// Copyright (C) 2025 EclipseSource GmbH.
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
const content_replacer_v2_impl_1 = require("./content-replacer-v2-impl");
describe('ContentReplacerV2Impl', () => {
    let contentReplacer;
    before(() => {
        contentReplacer = new content_replacer_v2_impl_1.ContentReplacerV2Impl();
    });
    // All original V1 test cases for backward compatibility
    describe('V1 compatibility tests', () => {
        it('should replace content when oldContent matches exactly', () => {
            const originalContent = 'Hello World!';
            const replacements = [
                { oldContent: 'World', newContent: 'Universe' }
            ];
            const expectedContent = 'Hello Universe!';
            const result = contentReplacer.applyReplacements(originalContent, replacements);
            (0, chai_1.expect)(result.updatedContent).to.equal(expectedContent);
            (0, chai_1.expect)(result.errors).to.be.empty;
        });
        it('should replace content when oldContent matches after trimming lines', () => {
            const originalContent = 'Line one\n   Line two   \nLine three';
            const replacements = [
                { oldContent: 'Line two', newContent: 'Second Line' }
            ];
            const expectedContent = 'Line one\n   Second Line   \nLine three';
            const result = contentReplacer.applyReplacements(originalContent, replacements);
            (0, chai_1.expect)(result.updatedContent).to.equal(expectedContent);
            (0, chai_1.expect)(result.errors).to.be.empty;
        });
        it('should return an error when oldContent is not found', () => {
            const originalContent = 'Sample content';
            const replacements = [
                { oldContent: 'Nonexistent', newContent: 'Replacement' }
            ];
            const result = contentReplacer.applyReplacements(originalContent, replacements);
            (0, chai_1.expect)(result.updatedContent).to.equal(originalContent);
            (0, chai_1.expect)(result.errors).to.include('Content to replace not found: "Nonexistent"');
        });
        it('should return an error when oldContent has multiple occurrences', () => {
            const originalContent = 'Repeat Repeat Repeat';
            const replacements = [
                { oldContent: 'Repeat', newContent: 'Once' }
            ];
            const result = contentReplacer.applyReplacements(originalContent, replacements);
            (0, chai_1.expect)(result.updatedContent).to.equal(originalContent);
            (0, chai_1.expect)(result.errors.some(candidate => candidate.startsWith('Multiple occurrences found for: "Repeat"'))).to.be.true;
        });
        it('should prepend newContent when oldContent is an empty string', () => {
            const originalContent = 'Existing content';
            const replacements = [
                { oldContent: '', newContent: 'Prepended content\n' }
            ];
            const expectedContent = 'Prepended content\nExisting content';
            const result = contentReplacer.applyReplacements(originalContent, replacements);
            (0, chai_1.expect)(result.updatedContent).to.equal(expectedContent);
            (0, chai_1.expect)(result.errors).to.be.empty;
        });
        it('should handle multiple replacements correctly', () => {
            const originalContent = 'Foo Bar Baz';
            const replacements = [
                { oldContent: 'Foo', newContent: 'FooModified' },
                { oldContent: 'Bar', newContent: 'BarModified' },
                { oldContent: 'Baz', newContent: 'BazModified' }
            ];
            const expectedContent = 'FooModified BarModified BazModified';
            const result = contentReplacer.applyReplacements(originalContent, replacements);
            (0, chai_1.expect)(result.updatedContent).to.equal(expectedContent);
            (0, chai_1.expect)(result.errors).to.be.empty;
        });
        it('should replace all occurrences when multiple is true', () => {
            const originalContent = 'Repeat Repeat Repeat';
            const replacements = [
                { oldContent: 'Repeat', newContent: 'Once', multiple: true }
            ];
            const expectedContent = 'Once Once Once';
            const result = contentReplacer.applyReplacements(originalContent, replacements);
            (0, chai_1.expect)(result.updatedContent).to.equal(expectedContent);
            (0, chai_1.expect)(result.errors).to.be.empty;
        });
        it('should return an error when multiple is false and multiple occurrences are found', () => {
            const originalContent = 'Repeat Repeat Repeat';
            const replacements = [
                { oldContent: 'Repeat', newContent: 'Once', multiple: false }
            ];
            const result = contentReplacer.applyReplacements(originalContent, replacements);
            (0, chai_1.expect)(result.updatedContent).to.equal(originalContent);
            (0, chai_1.expect)(result.errors.some(candidate => candidate.startsWith('Multiple occurrences found for: "Repeat"'))).to.be.true;
        });
        it('should return an error when conflicting replacements for the same oldContent are provided', () => {
            const originalContent = 'Conflict test content';
            const replacements = [
                { oldContent: 'test', newContent: 'test1' },
                { oldContent: 'test', newContent: 'test2' }
            ];
            const result = contentReplacer.applyReplacements(originalContent, replacements);
            (0, chai_1.expect)(result.updatedContent).to.equal(originalContent);
            (0, chai_1.expect)(result.errors).to.include('Conflicting replacement values for: "test"');
        });
    });
    // New V2 feature tests
    describe('V2 enhanced features', () => {
        describe('Line ending normalization', () => {
            it('should match content with different line endings (CRLF vs LF)', () => {
                const originalContent = 'Line one\r\nLine two\r\nLine three';
                const replacements = [
                    { oldContent: 'Line one\nLine two', newContent: 'Modified lines' }
                ];
                const expectedContent = 'Modified lines\r\nLine three';
                const result = contentReplacer.applyReplacements(originalContent, replacements);
                (0, chai_1.expect)(result.updatedContent).to.equal(expectedContent);
                (0, chai_1.expect)(result.errors).to.be.empty;
            });
            it('should preserve original line endings when replacing', () => {
                const originalContent = 'Line one\r\nLine two\r\nLine three';
                const replacements = [
                    { oldContent: 'Line two', newContent: 'New line\nWith LF' }
                ];
                const expectedContent = 'Line one\r\nNew line\r\nWith LF\r\nLine three';
                const result = contentReplacer.applyReplacements(originalContent, replacements);
                (0, chai_1.expect)(result.updatedContent).to.equal(expectedContent);
                (0, chai_1.expect)(result.errors).to.be.empty;
            });
            it('should handle mixed line endings', () => {
                const originalContent = 'Line one\nLine two\r\nLine three\rLine four';
                const replacements = [
                    { oldContent: 'Line two\nLine three', newContent: 'Replaced content' }
                ];
                const result = contentReplacer.applyReplacements(originalContent, replacements);
                (0, chai_1.expect)(result.errors).to.be.empty;
                (0, chai_1.expect)(result.updatedContent).to.include('Replaced content');
            });
        });
        describe('Multi-line fuzzy matching', () => {
            it('should match multi-line content with different indentation', () => {
                const originalContent = '    function test() {\n        console.log("hello");\n        return true;\n    }';
                const replacements = [
                    {
                        oldContent: 'function test() {\nconsole.log("hello");\nreturn true;\n}',
                        newContent: 'function test() {\n    console.log("modified");\n    return false;\n}'
                    }
                ];
                const expectedContent = '    function test() {\n        console.log("modified");\n        return false;\n    }';
                const result = contentReplacer.applyReplacements(originalContent, replacements);
                (0, chai_1.expect)(result.updatedContent).to.equal(expectedContent);
                (0, chai_1.expect)(result.errors).to.be.empty;
            });
            it('should match content with extra whitespace between lines', () => {
                const originalContent = 'function test() {\n    \n    console.log("hello");\n    \n}';
                const replacements = [
                    {
                        oldContent: 'function test() {\nconsole.log("hello");\n}',
                        newContent: 'function modified() {\n    console.log("world");\n}'
                    }
                ];
                const result = contentReplacer.applyReplacements(originalContent, replacements);
                (0, chai_1.expect)(result.errors).to.be.empty;
                (0, chai_1.expect)(result.updatedContent).to.include('function modified()');
                (0, chai_1.expect)(result.updatedContent).to.include('console.log("world")');
            });
            it('should match content with trailing whitespace on lines', () => {
                const originalContent = 'const x = 1;   \nconst y = 2;  \n';
                const replacements = [
                    {
                        oldContent: 'const x = 1;\nconst y = 2;',
                        newContent: 'const a = 3;\nconst b = 4;'
                    }
                ];
                const result = contentReplacer.applyReplacements(originalContent, replacements);
                (0, chai_1.expect)(result.errors).to.be.empty;
                (0, chai_1.expect)(result.updatedContent).to.include('const a = 3;');
                (0, chai_1.expect)(result.updatedContent).to.include('const b = 4;');
            });
        });
        describe('Indentation preservation', () => {
            it('should preserve indentation when replacing single line', () => {
                const originalContent = '    const x = 1;\n    const y = 2;';
                const replacements = [
                    { oldContent: 'const x = 1;', newContent: 'const a = 3;' }
                ];
                const expectedContent = '    const a = 3;\n    const y = 2;';
                const result = contentReplacer.applyReplacements(originalContent, replacements);
                (0, chai_1.expect)(result.updatedContent).to.equal(expectedContent);
                (0, chai_1.expect)(result.errors).to.be.empty;
            });
            it('should preserve relative indentation in multi-line replacements', () => {
                const originalContent = '    if (condition) {\n        doSomething();\n    }';
                const replacements = [
                    {
                        oldContent: 'if (condition) {\n    doSomething();\n}',
                        newContent: 'if (newCondition) {\n    doFirst();\n    doSecond();\n}'
                    }
                ];
                const expectedContent = '    if (newCondition) {\n        doFirst();\n        doSecond();\n    }';
                const result = contentReplacer.applyReplacements(originalContent, replacements);
                (0, chai_1.expect)(result.updatedContent).to.equal(expectedContent);
                (0, chai_1.expect)(result.errors).to.be.empty;
            });
            it('should handle tabs and spaces correctly', () => {
                const originalContent = '\tfunction test() {\n\t\tconsole.log("hello");\n\t}';
                const replacements = [
                    {
                        oldContent: 'function test() {\n    console.log("hello");\n}',
                        newContent: 'function modified() {\n    console.log("world");\n}'
                    }
                ];
                const result = contentReplacer.applyReplacements(originalContent, replacements);
                (0, chai_1.expect)(result.errors).to.be.empty;
                (0, chai_1.expect)(result.updatedContent).to.match(/^\tfunction modified/);
                (0, chai_1.expect)(result.updatedContent).to.include('\t\tconsole.log("world")');
            });
        });
        describe('Error handling improvements', () => {
            it('should truncate long content in error messages', () => {
                const longContent = 'a'.repeat(200);
                const originalContent = 'Some content';
                const replacements = [
                    { oldContent: longContent, newContent: 'replacement' }
                ];
                const result = contentReplacer.applyReplacements(originalContent, replacements);
                (0, chai_1.expect)(result.errors.length).to.equal(1);
                (0, chai_1.expect)(result.errors[0].length).to.be.lessThan(250); // Error message should be truncated
                (0, chai_1.expect)(result.errors[0]).to.include('...');
            });
        });
        describe('Complex scenarios', () => {
            it('should handle multiple replacements with different matching strategies', () => {
                const originalContent = 'Line 1\r\n    Line 2    \nLine 3\nExact match here';
                const replacements = [
                    { oldContent: 'Line 1\nLine 2', newContent: 'Modified 1-2' }, // Line ending normalization
                    { oldContent: 'Line 3', newContent: 'Modified 3' }, // Trimmed match
                    { oldContent: 'Exact match here', newContent: 'Exact replaced' } // Exact match
                ];
                const result = contentReplacer.applyReplacements(originalContent, replacements);
                (0, chai_1.expect)(result.errors).to.be.empty;
                (0, chai_1.expect)(result.updatedContent).to.include('Modified 1-2');
                (0, chai_1.expect)(result.updatedContent).to.include('Modified 3');
                (0, chai_1.expect)(result.updatedContent).to.include('Exact replaced');
            });
            it('should handle code blocks with varying indentation', () => {
                const originalContent = `
class MyClass {
    constructor() {
        this.value = 42;
    }
    
    getValue() {
        return this.value;
    }
}`;
                const replacements = [
                    {
                        oldContent: `getValue() {
return this.value;
}`,
                        newContent: `getValue() {
    console.log('Getting value');
    return this.value;
}`
                    }
                ];
                const result = contentReplacer.applyReplacements(originalContent, replacements);
                (0, chai_1.expect)(result.errors).to.be.empty;
                (0, chai_1.expect)(result.updatedContent).to.include("console.log('Getting value')");
                // Check that indentation is preserved
                (0, chai_1.expect)(result.updatedContent).to.match(/    getValue\(\) \{[\r\n\s]*console\.log/);
            });
            it('should handle empty lines in multi-line matches', () => {
                const originalContent = 'function test() {\n\n    return true;\n\n}';
                const replacements = [
                    {
                        oldContent: 'function test() {\n\nreturn true;\n\n}',
                        newContent: 'function test() {\n    return false;\n}'
                    }
                ];
                const result = contentReplacer.applyReplacements(originalContent, replacements);
                (0, chai_1.expect)(result.errors).to.be.empty;
                (0, chai_1.expect)(result.updatedContent).to.include('return false');
            });
        });
        describe('Multiple occurrences with fuzzy matching', () => {
            it('should handle multiple occurrences with fuzzy matching when multiple is true', () => {
                const originalContent = '    item1\n\n    item2\n\n    item1';
                const replacements = [
                    { oldContent: 'item1', newContent: 'replaced', multiple: true }
                ];
                const result = contentReplacer.applyReplacements(originalContent, replacements);
                (0, chai_1.expect)(result.errors).to.be.empty;
                (0, chai_1.expect)(result.updatedContent.match(/replaced/g)).to.have.length(2);
            });
            it('should detect multiple fuzzy matches and error when multiple is false', () => {
                const originalContent = '    function a() {}\n\n    function a() {}';
                const replacements = [
                    { oldContent: 'function a() {}', newContent: 'function b() {}', multiple: false }
                ];
                const result = contentReplacer.applyReplacements(originalContent, replacements);
                (0, chai_1.expect)(result.updatedContent).to.equal(originalContent);
                (0, chai_1.expect)(result.errors.some(err => err.includes('Multiple occurrences found'))).to.be.true;
            });
        });
    });
});
//# sourceMappingURL=content-replacer-v2-impl.spec.js.map