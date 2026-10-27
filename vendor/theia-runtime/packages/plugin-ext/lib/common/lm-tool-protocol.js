"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource.
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
exports.isToolInvocationError = void 0;
exports.uint8ArrayToBase64 = uint8ArrayToBase64;
exports.base64ToUint8Array = base64ToUint8Array;
const isToolInvocationError = (result) => typeof result === 'object' && 'error' in result && !('content' in result);
exports.isToolInvocationError = isToolInvocationError;
function uint8ArrayToBase64(data) {
    let binary = '';
    for (let i = 0; i < data.byteLength; i++) {
        binary += String.fromCharCode(data[i]);
    }
    return btoa(binary);
}
function base64ToUint8Array(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}
//# sourceMappingURL=lm-tool-protocol.js.map