"use strict";
// *****************************************************************************
// Copyright (C) 2021 SAP SE or an SAP affiliate company and others.
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
exports.TaskTerminalProcess = exports.TaskTerminalProcessFactory = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const terminal_process_1 = require("./terminal-process");
exports.TaskTerminalProcessFactory = Symbol('TaskTerminalProcessFactory');
let TaskTerminalProcess = class TaskTerminalProcess extends terminal_process_1.TerminalProcess {
    constructor() {
        super(...arguments);
        this.exited = false;
        this.attachmentAttempted = false;
        /**
         * Runtime-only property: whether to enable command history tracking for this task's terminal.
         * This value is injected from the `terminal.integrated.enableCommandHistory` preference
         * before the task is sent to the backend. It is not part of the task definition schema
         * and should not be persisted in tasks.json.
         */
        this._enableCommandHistory = false;
        // to avoid multiple end OSC injections
        this._endOscInjected = false;
    }
    setEnableCommandHistory(enable) {
        this._enableCommandHistory = enable;
    }
    /**
     * injects the command to be tracked into the terminal output stream
     * only if command history tracking is enabled
     */
    injectCommandStartOsc(command) {
        if (this._enableCommandHistory) {
            const encoded = Buffer.from(command).toString('hex');
            this.ringBuffer.enq(`\x1b]133;command_started;${encoded}\x07`);
            this._endOscInjected = false;
        }
    }
    onTerminalExit(code, signal) {
        this.injectCommandEndOsc();
        this.emitOnExit(code, signal);
        this.exited = true;
        // Unregister process only if task terminal already attached (or failed attach),
        // Fixes https://github.com/eclipse-theia/theia/issues/2961
        if (this.attachmentAttempted) {
            this.unregisterProcess();
        }
    }
    kill(signal) {
        this.injectCommandEndOsc();
        super.kill(signal);
    }
    injectCommandEndOsc() {
        if (this._enableCommandHistory && !this._endOscInjected) {
            // Mark the task command as finished in command history tracking.
            // OSC 133 'prompt_started' signals the end of command execution.
            this.ringBuffer.enq('\x1b]133;prompt_started\x07');
            this._endOscInjected = true;
        }
    }
};
exports.TaskTerminalProcess = TaskTerminalProcess;
exports.TaskTerminalProcess = TaskTerminalProcess = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], TaskTerminalProcess);
//# sourceMappingURL=task-terminal-process.js.map