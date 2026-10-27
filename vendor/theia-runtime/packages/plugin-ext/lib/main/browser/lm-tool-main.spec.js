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
const lm_tool_main_1 = require("./lm-tool-main");
const lm_tool_protocol_1 = require("../../common/lm-tool-protocol");
const buffer_1 = require("@theia/core/lib/common/buffer");
function createInstance() {
    const impl = Object.create(lm_tool_main_1.LanguageModelToolsMainImpl.prototype);
    return impl;
}
describe('LanguageModelToolsMainImpl - DTO to ToolCallContentResult conversion', () => {
    let instance;
    beforeEach(() => {
        instance = createInstance();
    });
    describe('convertDtoToToolCallResult', () => {
        it('should convert text part DTO to ToolCallTextResult', () => {
            const part = { type: 'text', value: 'hello world' };
            const result = instance.convertDtoToToolCallResult(part);
            (0, chai_1.expect)(result).to.deep.equal({ type: 'text', text: 'hello world' });
        });
        it('should convert prompt-tsx part DTO to ToolCallTextResult with JSON', () => {
            const part = { type: 'prompt-tsx', value: { foo: 'bar' } };
            const result = instance.convertDtoToToolCallResult(part);
            (0, chai_1.expect)(result).to.deep.equal({ type: 'text', text: '{"foo":"bar"}' });
        });
        it('should convert unknown part DTO to ToolCallTextResult', () => {
            const part = { type: 'unknown', json: '{"custom":"data"}' };
            const result = instance.convertDtoToToolCallResult(part);
            (0, chai_1.expect)(result).to.deep.equal({ type: 'text', text: '{"custom":"data"}' });
        });
        it('should convert data part with image mimeType to ToolCallImageResult', () => {
            const base64 = btoa('fake-image-data');
            const part = { type: 'data', base64, mimeType: 'image/png' };
            const result = instance.convertDtoToToolCallResult(part);
            (0, chai_1.expect)(result).to.deep.equal({ type: 'image', base64data: base64, mimeType: 'image/png' });
        });
        it('should convert data part with audio mimeType to ToolCallAudioResult', () => {
            const base64 = btoa('fake-audio-data');
            const part = { type: 'data', base64, mimeType: 'audio/mp3' };
            const result = instance.convertDtoToToolCallResult(part);
            (0, chai_1.expect)(result).to.deep.equal({ type: 'audio', data: base64, mimeType: 'audio/mp3' });
        });
        it('should convert data part with text/plain mimeType to ToolCallTextResult', () => {
            const base64 = btoa('plain text content');
            const part = { type: 'data', base64, mimeType: 'text/plain' };
            const result = instance.convertDtoToToolCallResult(part);
            (0, chai_1.expect)(result).to.deep.equal({ type: 'text', text: 'plain text content' });
        });
        it('should convert data part with application/json mimeType to ToolCallTextResult', () => {
            const jsonString = '{"key":"value"}';
            const base64 = btoa(jsonString);
            const part = { type: 'data', base64, mimeType: 'application/json' };
            const result = instance.convertDtoToToolCallResult(part);
            (0, chai_1.expect)(result).to.deep.equal({ type: 'text', text: jsonString });
        });
        it('should convert data part with text/x-json mimeType to ToolCallTextResult', () => {
            const jsonString = '{"data":123}';
            const base64 = btoa(jsonString);
            const part = { type: 'data', base64, mimeType: 'text/x-json' };
            const result = instance.convertDtoToToolCallResult(part);
            (0, chai_1.expect)(result).to.deep.equal({ type: 'text', text: jsonString });
        });
        it('should convert data part with image/jpeg mimeType to ToolCallImageResult', () => {
            const base64 = btoa('jpeg-data');
            const part = { type: 'data', base64, mimeType: 'image/jpeg' };
            const result = instance.convertDtoToToolCallResult(part);
            (0, chai_1.expect)(result).to.deep.equal({ type: 'image', base64data: base64, mimeType: 'image/jpeg' });
        });
        it('should convert data part with audio/wav mimeType to ToolCallAudioResult', () => {
            const base64 = btoa('wav-data');
            const part = { type: 'data', base64, mimeType: 'audio/wav' };
            const result = instance.convertDtoToToolCallResult(part);
            (0, chai_1.expect)(result).to.deep.equal({ type: 'audio', data: base64, mimeType: 'audio/wav' });
        });
        it('should correctly decode UTF-8 text from base64 data part', () => {
            const utf8Text = 'café 日本語';
            const base64 = (0, lm_tool_protocol_1.uint8ArrayToBase64)(buffer_1.BinaryBuffer.fromString(utf8Text).buffer);
            const part = { type: 'data', base64, mimeType: 'text/plain' };
            const result = instance.convertDtoToToolCallResult(part);
            (0, chai_1.expect)(result).to.deep.equal({ type: 'text', text: utf8Text });
        });
    });
});
//# sourceMappingURL=lm-tool-main.spec.js.map