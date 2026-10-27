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
const lm_tool_ext_1 = require("./lm-tool-ext");
const lm_tool_protocol_1 = require("../common/lm-tool-protocol");
function createInstance() {
    const impl = Object.create(lm_tool_ext_1.LanguageModelToolsExtImpl.prototype);
    return impl;
}
describe('LanguageModelToolsExtImpl - Part to DTO conversion', () => {
    let instance;
    beforeEach(() => {
        instance = createInstance();
    });
    describe('isTextPart', () => {
        it('should return true for a text part with string value', () => {
            (0, chai_1.expect)(instance.isTextPart({ value: 'hello' })).to.be.true;
        });
        it('should return false for a data part (has data and mimeType)', () => {
            (0, chai_1.expect)(instance.isTextPart({ data: new Uint8Array([1, 2]), mimeType: 'text/plain' })).to.be.false;
        });
        it('should return false for a non-string value', () => {
            (0, chai_1.expect)(instance.isTextPart({ value: { foo: 'bar' } })).to.be.false;
        });
        it('should return false for undefined', () => {
            (0, chai_1.expect)(instance.isTextPart(undefined)).to.be.false;
        });
    });
    describe('isDataPart', () => {
        it('should return true for a data part', () => {
            (0, chai_1.expect)(instance.isDataPart({ data: new Uint8Array([1, 2]), mimeType: 'image/png' })).to.be.true;
        });
        it('should return false for a text part', () => {
            (0, chai_1.expect)(instance.isDataPart({ value: 'hello' })).to.be.false;
        });
        it('should return false for undefined', () => {
            (0, chai_1.expect)(instance.isDataPart(undefined)).to.be.false;
        });
    });
    describe('isPromptTsxPart', () => {
        it('should return true for a prompt-tsx part with non-string value', () => {
            (0, chai_1.expect)(instance.isPromptTsxPart({ value: { component: 'div' } })).to.be.true;
        });
        it('should return false for a text part with string value', () => {
            (0, chai_1.expect)(instance.isPromptTsxPart({ value: 'hello' })).to.be.false;
        });
        it('should return false for a data part', () => {
            (0, chai_1.expect)(instance.isPromptTsxPart({ data: new Uint8Array(), mimeType: 'text/plain' })).to.be.false;
        });
    });
    describe('uint8ArrayToBase64', () => {
        it('should encode an empty array', () => {
            const result = (0, lm_tool_protocol_1.uint8ArrayToBase64)(new Uint8Array([]));
            (0, chai_1.expect)(result).to.equal('');
        });
        it('should encode a simple string as Uint8Array', () => {
            const data = new Uint8Array(Buffer.from('hello'));
            const result = (0, lm_tool_protocol_1.uint8ArrayToBase64)(data);
            (0, chai_1.expect)(result).to.equal(Buffer.from('hello').toString('base64'));
        });
        it('should encode binary data', () => {
            const data = new Uint8Array([0, 1, 2, 255]);
            const result = (0, lm_tool_protocol_1.uint8ArrayToBase64)(data);
            (0, chai_1.expect)(result).to.equal(Buffer.from([0, 1, 2, 255]).toString('base64'));
        });
    });
    describe('convertPartToDto', () => {
        it('should convert a LanguageModelTextPart to text DTO', () => {
            const part = { value: 'some text' };
            const result = instance.convertPartToDto(part);
            (0, chai_1.expect)(result).to.deep.equal({ type: 'text', value: 'some text' });
        });
        it('should convert a LanguageModelDataPart to data DTO', () => {
            const data = new Uint8Array(Buffer.from('binary content'));
            const part = { data, mimeType: 'application/octet-stream' };
            const result = instance.convertPartToDto(part);
            (0, chai_1.expect)(result.type).to.equal('data');
            (0, chai_1.expect)(result.base64).to.equal(Buffer.from('binary content').toString('base64'));
            (0, chai_1.expect)(result.mimeType).to.equal('application/octet-stream');
        });
        it('should convert a LanguageModelPromptTsxPart to prompt-tsx DTO', () => {
            const part = { value: { component: 'SomeComponent', props: { x: 1 } } };
            const result = instance.convertPartToDto(part);
            (0, chai_1.expect)(result).to.deep.equal({ type: 'prompt-tsx', value: { component: 'SomeComponent', props: { x: 1 } } });
        });
        it('should convert an unknown part to unknown DTO', () => {
            const part = { someUnknownField: 42 };
            const result = instance.convertPartToDto(part);
            (0, chai_1.expect)(result).to.deep.equal({ type: 'unknown', json: '{"someUnknownField":42}' });
        });
        it('should convert a LanguageModelDataPart with image mime type to data DTO', () => {
            const imageData = new Uint8Array([137, 80, 78, 71]); // PNG header bytes
            const part = { data: imageData, mimeType: 'image/png' };
            const result = instance.convertPartToDto(part);
            (0, chai_1.expect)(result.type).to.equal('data');
            (0, chai_1.expect)(result.base64).to.equal(Buffer.from(imageData).toString('base64'));
            (0, chai_1.expect)(result.mimeType).to.equal('image/png');
        });
        it('should convert a LanguageModelDataPart with text/x-json to data DTO', () => {
            const jsonStr = '{"key":"value"}';
            const data = new Uint8Array(Buffer.from(jsonStr));
            const part = { data, mimeType: 'text/x-json' };
            const result = instance.convertPartToDto(part);
            (0, chai_1.expect)(result.type).to.equal('data');
            (0, chai_1.expect)(result.base64).to.equal(Buffer.from(jsonStr).toString('base64'));
        });
    });
});
//# sourceMappingURL=lm-tool-ext.spec.js.map