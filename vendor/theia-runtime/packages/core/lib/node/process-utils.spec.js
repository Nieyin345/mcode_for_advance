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
const chai_1 = require("chai");
const sinon = require("sinon");
const inversify_1 = require("inversify");
const process_utils_1 = require("./process-utils");
const common_1 = require("../common");
const mock_logger_1 = require("../common/test/mock-logger");
/** PPID, PID */
const mockPsOutput = `\
     5     6
    40     7
     1     2
     1     3
     2    40
     2     5
     0     1
`;
describe('ProcessUtils', () => {
    let coreProcessManager;
    beforeEach(() => {
        const container = new inversify_1.Container();
        container.bind(process_utils_1.ProcessUtils).toSelf().inSingletonScope();
        container.bind(common_1.ILogger).to(mock_logger_1.MockLogger).inSingletonScope();
        coreProcessManager = container.get(process_utils_1.ProcessUtils);
    });
    it('ProcessUtils#unixGetChildrenRecursive', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        coreProcessManager['spawnSync'] = () => ({ stdout: mockPsOutput });
        const pids = coreProcessManager['unixGetChildrenRecursive'](2);
        (0, chai_1.expect)(Array.from(pids)).members([40, 5, 6, 7]);
    });
    describe('#unixTerminateProcessTree', () => {
        let originalKill;
        let errorStub;
        function throwingKill(code) {
            return (() => {
                const error = new Error(`kill ${code}`);
                error.code = code;
                throw error;
            });
        }
        beforeEach(() => {
            originalKill = process.kill;
            const mockLogger = coreProcessManager.logger;
            errorStub = sinon.stub(mockLogger, 'error');
            // One child plus the parent; report the parent as its own group leader so the `kill(-ppid)` branch runs too.
            coreProcessManager['unixGetChildrenRecursive'] = () => new Set([424242]);
            coreProcessManager['unixGetPGID'] = (pid) => pid;
        });
        afterEach(() => {
            process.kill = originalKill;
            sinon.restore();
        });
        it('does not throw or log when processes in the tree are already gone (ESRCH)', () => {
            process.kill = throwingKill('ESRCH');
            (0, chai_1.expect)(() => coreProcessManager['unixTerminateProcessTree'](424243)).to.not.throw();
            (0, chai_1.expect)(errorStub.called).to.be.false;
        });
        it('logs unexpected kill errors (e.g. EPERM) without throwing', () => {
            process.kill = throwingKill('EPERM');
            (0, chai_1.expect)(() => coreProcessManager['unixTerminateProcessTree'](424243)).to.not.throw();
            (0, chai_1.expect)(errorStub.called).to.be.true;
        });
        it('does not throw when a kill rejects with a value that has no code (e.g. undefined)', () => {
            const thrown = undefined;
            process.kill = (() => { throw thrown; });
            (0, chai_1.expect)(() => coreProcessManager['unixTerminateProcessTree'](424243)).to.not.throw();
            (0, chai_1.expect)(errorStub.called).to.be.true;
        });
    });
});
//# sourceMappingURL=process-utils.spec.js.map