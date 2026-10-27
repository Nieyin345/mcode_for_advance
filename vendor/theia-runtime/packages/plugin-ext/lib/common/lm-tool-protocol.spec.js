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
const lm_tool_protocol_1 = require("./lm-tool-protocol");
const buffer_1 = require("@theia/core/lib/common/buffer");
describe('lm-tool-protocol base64 helpers', () => {
    describe('uint8ArrayToBase64', () => {
        it('should encode an empty array to an empty string', () => {
            (0, chai_1.expect)((0, lm_tool_protocol_1.uint8ArrayToBase64)(new Uint8Array([]))).to.equal('');
        });
        it('should encode ASCII bytes to expected base64', () => {
            const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
            (0, chai_1.expect)((0, lm_tool_protocol_1.uint8ArrayToBase64)(data)).to.equal('SGVsbG8=');
        });
        it('should encode binary data with byte 0 and 255', () => {
            const data = new Uint8Array([0, 127, 128, 255]);
            const base64 = (0, lm_tool_protocol_1.uint8ArrayToBase64)(data);
            (0, chai_1.expect)(base64).to.equal(btoa('\x00\x7f\x80\xff'));
        });
    });
    describe('base64ToUint8Array', () => {
        it('should decode an empty string to an empty Uint8Array', () => {
            const result = (0, lm_tool_protocol_1.base64ToUint8Array)('');
            (0, chai_1.expect)(result).to.be.instanceOf(Uint8Array);
            (0, chai_1.expect)(result.length).to.equal(0);
        });
        it('should decode known base64 to expected bytes', () => {
            const result = (0, lm_tool_protocol_1.base64ToUint8Array)('SGVsbG8=');
            (0, chai_1.expect)(Array.from(result)).to.deep.equal([72, 101, 108, 108, 111]);
        });
        it('should round-trip binary data', () => {
            const original = new Uint8Array([0, 1, 127, 128, 255]);
            const base64 = (0, lm_tool_protocol_1.uint8ArrayToBase64)(original);
            const decoded = (0, lm_tool_protocol_1.base64ToUint8Array)(base64);
            (0, chai_1.expect)(Array.from(decoded)).to.deep.equal(Array.from(original));
        });
    });
    describe('round-trip symmetry', () => {
        it('should round-trip ASCII text', () => {
            const text = 'Hello World';
            const encoded = (0, lm_tool_protocol_1.uint8ArrayToBase64)(buffer_1.BinaryBuffer.fromString(text).buffer);
            const decoded = buffer_1.BinaryBuffer.wrap((0, lm_tool_protocol_1.base64ToUint8Array)(encoded)).toString();
            (0, chai_1.expect)(decoded).to.equal(text);
        });
        it('should round-trip UTF-8 text', () => {
            const text = 'café 日本語 🎉';
            const encoded = (0, lm_tool_protocol_1.uint8ArrayToBase64)(buffer_1.BinaryBuffer.fromString(text).buffer);
            const decoded = buffer_1.BinaryBuffer.wrap((0, lm_tool_protocol_1.base64ToUint8Array)(encoded)).toString();
            (0, chai_1.expect)(decoded).to.equal(text);
        });
        it('should round-trip binary data', () => {
            const original = new Uint8Array([0, 1, 127, 128, 255]);
            const base64 = (0, lm_tool_protocol_1.uint8ArrayToBase64)(original);
            const result = (0, lm_tool_protocol_1.base64ToUint8Array)(base64);
            (0, chai_1.expect)(Array.from(result)).to.deep.equal(Array.from(original));
        });
        it('should round-trip JSON text with UTF-8 characters', () => {
            const text = '{"key":"données"}';
            const encoded = (0, lm_tool_protocol_1.uint8ArrayToBase64)(buffer_1.BinaryBuffer.fromString(text).buffer);
            const decoded = buffer_1.BinaryBuffer.wrap((0, lm_tool_protocol_1.base64ToUint8Array)(encoded)).toString();
            (0, chai_1.expect)(decoded).to.equal(text);
        });
    });
});
//# sourceMappingURL=lm-tool-protocol.spec.js.map