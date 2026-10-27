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
var TerminalCommandHistoryStateImpl_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.TerminalCommandHistoryStateImpl = exports.TerminalCommandHistoryStateFactory = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const inversify_1 = require("@theia/core/shared/inversify");
exports.TerminalCommandHistoryStateFactory = Symbol('TerminalCommandHistoryStateFactory');
let TerminalCommandHistoryStateImpl = class TerminalCommandHistoryStateImpl {
    static { TerminalCommandHistoryStateImpl_1 = this; }
    static { this.MAX_CAPACITY = 200; }
    get commandHistory() { return this._commandHistory; }
    get currentCommand() { return this._currentCommand; }
    constructor() {
        this._commandHistory = [];
        this._currentCommand = '';
        this.toDispose = new core_1.DisposableCollection();
        this.onCommandStartEmitter = new core_1.Emitter();
        this.onPromptShownEmitter = new core_1.Emitter();
        this.onTerminalCommandStart = this.onCommandStartEmitter.event;
        this.onTerminalPromptShown = this.onPromptShownEmitter.event;
        this.toDispose.push(this.onCommandStartEmitter);
        this.toDispose.push(this.onPromptShownEmitter);
        this._maxCapacity = TerminalCommandHistoryStateImpl_1.MAX_CAPACITY;
    }
    startCommand(command) {
        this._currentCommand = this.decodeHexString(command);
        this.onCommandStartEmitter.fire();
    }
    finishCommand(block) {
        this._commandHistory.push(block);
        if (this._commandHistory.length > this._maxCapacity) {
            this._commandHistory.shift();
        }
        this._currentCommand = '';
        this.onPromptShownEmitter.fire();
    }
    clearCommandCollectionState() {
        this._currentCommand = '';
    }
    dispose() {
        this._commandHistory = [];
        this.toDispose.dispose();
    }
    /**
     * Decodes a hex-encoded string to UTF-8 using browser-compatible APIs.
     */
    decodeHexString(hexString) {
        if (!hexString) {
            return '';
        }
        const hexBytes = new Uint8Array((hexString.match(/.{1,2}/g) || []).map(byte => parseInt(byte, 16)));
        return new TextDecoder('utf-8').decode(hexBytes);
    }
};
exports.TerminalCommandHistoryStateImpl = TerminalCommandHistoryStateImpl;
exports.TerminalCommandHistoryStateImpl = TerminalCommandHistoryStateImpl = TerminalCommandHistoryStateImpl_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__metadata("design:paramtypes", [])
], TerminalCommandHistoryStateImpl);
//# sourceMappingURL=terminal-command-history.js.map