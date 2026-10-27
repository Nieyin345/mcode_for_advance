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
const capability_utils_1 = require("./capability-utils");
describe('capability-utils', () => {
    describe('parseCapabilitiesFromTemplate', () => {
        it('should parse a capability with default on', () => {
            const template = 'Some text {{capability:feature-one default on}} more text';
            const result = (0, capability_utils_1.parseCapabilitiesFromTemplate)(template);
            (0, chai_1.expect)(result).to.have.lengthOf(1);
            (0, chai_1.expect)(result[0]).to.deep.equal({
                fragmentId: 'feature-one',
                defaultEnabled: true
            });
        });
        it('should parse a capability with default off', () => {
            const template = 'Some text {{capability:feature-two default off}} more text';
            const result = (0, capability_utils_1.parseCapabilitiesFromTemplate)(template);
            (0, chai_1.expect)(result).to.have.lengthOf(1);
            (0, chai_1.expect)(result[0]).to.deep.equal({
                fragmentId: 'feature-two',
                defaultEnabled: false
            });
        });
        it('should parse multiple capabilities', () => {
            const template = `
                {{capability:feature-a default on}}
                {{capability:feature-b default off}}
                {{capability:feature-c default on}}
            `;
            const result = (0, capability_utils_1.parseCapabilitiesFromTemplate)(template);
            (0, chai_1.expect)(result).to.have.lengthOf(3);
            (0, chai_1.expect)(result[0].fragmentId).to.equal('feature-a');
            (0, chai_1.expect)(result[0].defaultEnabled).to.be.true;
            (0, chai_1.expect)(result[1].fragmentId).to.equal('feature-b');
            (0, chai_1.expect)(result[1].defaultEnabled).to.be.false;
            (0, chai_1.expect)(result[2].fragmentId).to.equal('feature-c');
            (0, chai_1.expect)(result[2].defaultEnabled).to.be.true;
        });
        it('should parse triple brace syntax', () => {
            const template = 'Text {{{capability:my-feature default on}}} end';
            const result = (0, capability_utils_1.parseCapabilitiesFromTemplate)(template);
            (0, chai_1.expect)(result).to.have.lengthOf(1);
            (0, chai_1.expect)(result[0]).to.deep.equal({
                fragmentId: 'my-feature',
                defaultEnabled: true
            });
        });
        it('should handle mixed brace syntax', () => {
            const template = `
                {{capability:feature-double default on}}
                {{{capability:feature-triple default off}}}
            `;
            const result = (0, capability_utils_1.parseCapabilitiesFromTemplate)(template);
            (0, chai_1.expect)(result).to.have.lengthOf(2);
            (0, chai_1.expect)(result[0].fragmentId).to.equal('feature-double');
            (0, chai_1.expect)(result[1].fragmentId).to.equal('feature-triple');
        });
        it('should deduplicate capabilities with same fragmentId', () => {
            const template = `
                {{capability:same-feature default on}}
                {{capability:same-feature default off}}
            `;
            const result = (0, capability_utils_1.parseCapabilitiesFromTemplate)(template);
            // Should only return the first occurrence
            (0, chai_1.expect)(result).to.have.lengthOf(1);
            (0, chai_1.expect)(result[0].fragmentId).to.equal('same-feature');
            (0, chai_1.expect)(result[0].defaultEnabled).to.be.true;
        });
        it('should return empty array for template without capabilities', () => {
            const template = 'This is a template with {{variable}} but no capabilities';
            const result = (0, capability_utils_1.parseCapabilitiesFromTemplate)(template);
            (0, chai_1.expect)(result).to.have.lengthOf(0);
        });
        it('should handle case-insensitive default on/off', () => {
            const template = `
                {{capability:upper-on default ON}}
                {{capability:upper-off default OFF}}
                {{capability:mixed-on default On}}
            `;
            const result = (0, capability_utils_1.parseCapabilitiesFromTemplate)(template);
            (0, chai_1.expect)(result).to.have.lengthOf(3);
            (0, chai_1.expect)(result[0].defaultEnabled).to.be.true;
            (0, chai_1.expect)(result[1].defaultEnabled).to.be.false;
            (0, chai_1.expect)(result[2].defaultEnabled).to.be.true;
        });
        it('should handle whitespace variations', () => {
            const template = `
                {{  capability:spaced-feature   default   on  }}
                {{ capability:another-feature default off }}
            `;
            const result = (0, capability_utils_1.parseCapabilitiesFromTemplate)(template);
            (0, chai_1.expect)(result).to.have.lengthOf(2);
            (0, chai_1.expect)(result[0].fragmentId).to.equal('spaced-feature');
            (0, chai_1.expect)(result[1].fragmentId).to.equal('another-feature');
        });
        it('should handle fragment IDs with hyphens', () => {
            const template = '{{capability:my-complex-feature-name default on}}';
            const result = (0, capability_utils_1.parseCapabilitiesFromTemplate)(template);
            (0, chai_1.expect)(result).to.have.lengthOf(1);
            (0, chai_1.expect)(result[0].fragmentId).to.equal('my-complex-feature-name');
        });
        it('should handle fragment IDs with underscores', () => {
            const template = '{{capability:my_feature_name default off}}';
            const result = (0, capability_utils_1.parseCapabilitiesFromTemplate)(template);
            (0, chai_1.expect)(result).to.have.lengthOf(1);
            (0, chai_1.expect)(result[0].fragmentId).to.equal('my_feature_name');
        });
        it('should default to off when default on/off is omitted', () => {
            const template = '{{capability:implicit-off}}';
            const result = (0, capability_utils_1.parseCapabilitiesFromTemplate)(template);
            (0, chai_1.expect)(result).to.have.lengthOf(1);
            (0, chai_1.expect)(result[0]).to.deep.equal({
                fragmentId: 'implicit-off',
                defaultEnabled: false
            });
        });
        it('should handle mixed explicit and implicit defaults', () => {
            const template = `
                {{capability:explicit-on default on}}
                {{capability:implicit-off-feature}}
                {{capability:explicit-off default off}}
            `;
            const result = (0, capability_utils_1.parseCapabilitiesFromTemplate)(template);
            (0, chai_1.expect)(result).to.have.lengthOf(3);
            (0, chai_1.expect)(result[0]).to.deep.equal({ fragmentId: 'explicit-on', defaultEnabled: true });
            (0, chai_1.expect)(result[1]).to.deep.equal({ fragmentId: 'implicit-off-feature', defaultEnabled: false });
            (0, chai_1.expect)(result[2]).to.deep.equal({ fragmentId: 'explicit-off', defaultEnabled: false });
        });
        it('should handle triple brace syntax without default', () => {
            const template = '{{{capability:triple-implicit}}}';
            const result = (0, capability_utils_1.parseCapabilitiesFromTemplate)(template);
            (0, chai_1.expect)(result).to.have.lengthOf(1);
            (0, chai_1.expect)(result[0]).to.deep.equal({
                fragmentId: 'triple-implicit',
                defaultEnabled: false
            });
        });
        it('should preserve order of first occurrence for duplicates', () => {
            const template = `
                {{capability:first default on}}
                {{capability:second default off}}
                {{capability:first default off}}
                {{capability:third default on}}
            `;
            const result = (0, capability_utils_1.parseCapabilitiesFromTemplate)(template);
            (0, chai_1.expect)(result).to.have.lengthOf(3);
            (0, chai_1.expect)(result[0].fragmentId).to.equal('first');
            (0, chai_1.expect)(result[0].defaultEnabled).to.be.true; // First occurrence
            (0, chai_1.expect)(result[1].fragmentId).to.equal('second');
            (0, chai_1.expect)(result[2].fragmentId).to.equal('third');
        });
        it('should return capabilities in the order they appear in template', () => {
            const template = `
                Middle text {{capability:zeta default on}}
                Start {{capability:alpha default off}}
                End {{capability:omega default on}}
            `;
            const result = (0, capability_utils_1.parseCapabilitiesFromTemplate)(template);
            (0, chai_1.expect)(result).to.have.lengthOf(3);
            (0, chai_1.expect)(result[0].fragmentId).to.equal('zeta');
            (0, chai_1.expect)(result[1].fragmentId).to.equal('alpha');
            (0, chai_1.expect)(result[2].fragmentId).to.equal('omega');
        });
    });
    describe('parseCapabilityArgument', () => {
        it('should parse a valid argument with default on', () => {
            const result = (0, capability_utils_1.parseCapabilityArgument)('feature-one default on');
            (0, chai_1.expect)(result).to.deep.equal({ fragmentId: 'feature-one', defaultEnabled: true });
        });
        it('should parse a valid argument with default off', () => {
            const result = (0, capability_utils_1.parseCapabilityArgument)('feature-two default off');
            (0, chai_1.expect)(result).to.deep.equal({ fragmentId: 'feature-two', defaultEnabled: false });
        });
        it('should handle case-insensitive on/off', () => {
            (0, chai_1.expect)((0, capability_utils_1.parseCapabilityArgument)('feat default ON')?.defaultEnabled).to.be.true;
            (0, chai_1.expect)((0, capability_utils_1.parseCapabilityArgument)('feat default OFF')?.defaultEnabled).to.be.false;
            (0, chai_1.expect)((0, capability_utils_1.parseCapabilityArgument)('feat default On')?.defaultEnabled).to.be.true;
        });
        it('should handle whitespace in arguments', () => {
            const result = (0, capability_utils_1.parseCapabilityArgument)('  test-capability   default   on  ');
            (0, chai_1.expect)(result).to.not.be.undefined;
            (0, chai_1.expect)(result.fragmentId).to.equal('test-capability');
            (0, chai_1.expect)(result.defaultEnabled).to.be.true;
        });
        it('should default to off when default on/off is omitted', () => {
            const result = (0, capability_utils_1.parseCapabilityArgument)('feature-only');
            (0, chai_1.expect)(result).to.deep.equal({ fragmentId: 'feature-only', defaultEnabled: false });
        });
        it('should default to off for fragment IDs with hyphens and no default', () => {
            const result = (0, capability_utils_1.parseCapabilityArgument)('my-complex-feature');
            (0, chai_1.expect)(result).to.deep.equal({ fragmentId: 'my-complex-feature', defaultEnabled: false });
        });
        it('should treat incomplete default clause as part of fragment ID', () => {
            // "default" without on/off is not a valid default clause,
            // so the whole string becomes the fragment ID
            const result1 = (0, capability_utils_1.parseCapabilityArgument)('test-capability default');
            (0, chai_1.expect)(result1).to.deep.equal({ fragmentId: 'test-capability default', defaultEnabled: false });
            const result2 = (0, capability_utils_1.parseCapabilityArgument)('test-capability default yes');
            (0, chai_1.expect)(result2).to.deep.equal({ fragmentId: 'test-capability default yes', defaultEnabled: false });
        });
        it('should return undefined for empty string', () => {
            (0, chai_1.expect)((0, capability_utils_1.parseCapabilityArgument)('')).to.be.undefined;
        });
        it('should return undefined for whitespace-only string', () => {
            (0, chai_1.expect)((0, capability_utils_1.parseCapabilityArgument)('   ')).to.be.undefined;
        });
    });
});
//# sourceMappingURL=capability-utils.spec.js.map