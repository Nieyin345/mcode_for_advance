"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource and others.
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
const tslib_1 = require("tslib");
const chai_1 = require("chai");
const sinon = require("sinon");
const inversify_1 = require("inversify");
const common_1 = require("../common");
const promise_util_1 = require("../common/promise-util");
const node_stopwatch_1 = require("./performance/node-stopwatch");
const process_utils_1 = require("./process-utils");
const backend_application_1 = require("./backend-application");
const cli_1 = require("./cli");
const mock_logger_1 = require("../common/test/mock-logger");
/**
 * Test subclass that exposes the protected `gracefulShutdown` for direct testing.
 */
let TestBackendApplication = class TestBackendApplication extends backend_application_1.BackendApplication {
    invokeGracefulShutdown() {
        return this.gracefulShutdown();
    }
};
TestBackendApplication = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], TestBackendApplication);
// All process events on which `BackendApplication` installs listeners in its
// constructor. We snapshot and restore them around each test to avoid leaking
// listeners across tests (and triggering `MaxListenersExceededWarning`).
const PROCESS_EVENTS = ['SIGINT', 'SIGTERM', 'SIGPIPE', 'exit', 'uncaughtException'];
describe('BackendApplication', () => {
    let sandbox;
    let exitStub;
    let savedListeners;
    beforeEach(() => {
        sandbox = sinon.createSandbox();
        // Snapshot any existing listeners so we can restore after each test
        // (BackendApplication installs its own as part of construction).
        savedListeners = {};
        for (const evt of PROCESS_EVENTS) {
            savedListeners[evt] = [...process.listeners(evt)];
            process.removeAllListeners(evt);
        }
        exitStub = sandbox.stub(process, 'exit');
    });
    afterEach(() => {
        for (const evt of PROCESS_EVENTS) {
            process.removeAllListeners(evt);
            for (const listener of savedListeners[evt] ?? []) {
                process.on(evt, listener);
            }
        }
        sandbox.restore();
    });
    function createTestContainer() {
        const container = new inversify_1.Container();
        container.bind(backend_application_1.RootContainer).toConstantValue(container);
        container.bind(common_1.ILogger).to(mock_logger_1.MockLogger).inSingletonScope();
        container.bind(common_1.Stopwatch).to(node_stopwatch_1.NodeStopwatch).inSingletonScope();
        container.bind(process_utils_1.ProcessUtils).toSelf().inSingletonScope();
        container.bind(backend_application_1.BackendApplicationCliContribution).toSelf().inSingletonScope();
        container.bind(cli_1.CliContribution).toService(backend_application_1.BackendApplicationCliContribution);
        container.bind(backend_application_1.EarlyExpressMiddleware).toSelf().inSingletonScope();
        (0, common_1.bindContributionProvider)(container, backend_application_1.BackendApplicationContribution);
        container.bind(TestBackendApplication).toSelf().inSingletonScope();
        container.bind(backend_application_1.BackendApplication).toService(TestBackendApplication);
        return container;
    }
    describe('graceful shutdown', () => {
        it('runs @preDestroy on root-scoped singletons before exiting with code 1', async () => {
            let canaryDisposed = false;
            let Canary = class Canary {
                onPreDestroy() {
                    canaryDisposed = true;
                }
            };
            tslib_1.__decorate([
                (0, inversify_1.preDestroy)(),
                tslib_1.__metadata("design:type", Function),
                tslib_1.__metadata("design:paramtypes", []),
                tslib_1.__metadata("design:returntype", void 0)
            ], Canary.prototype, "onPreDestroy", null);
            Canary = tslib_1.__decorate([
                (0, inversify_1.injectable)()
            ], Canary);
            const container = createTestContainer();
            const canaryModule = new inversify_1.ContainerModule(bind => {
                bind(Canary).toSelf().inSingletonScope();
            });
            container.load(canaryModule);
            container.get(Canary);
            const app = container.get(TestBackendApplication);
            await app.invokeGracefulShutdown();
            (0, chai_1.expect)(canaryDisposed, '@preDestroy was not invoked on root-scoped singleton').to.be.true;
            (0, chai_1.expect)(exitStub.calledOnceWith(1), 'process.exit(1) was not called exactly once').to.be.true;
        });
        it('is idempotent: a second invocation does not unbind the container twice', async () => {
            const container = createTestContainer();
            const unbindSpy = sandbox.spy(container, 'unbindAllAsync');
            const app = container.get(TestBackendApplication);
            await app.invokeGracefulShutdown();
            await app.invokeGracefulShutdown();
            (0, chai_1.expect)(unbindSpy.callCount, 'unbindAllAsync should be called only once').to.equal(1);
            (0, chai_1.expect)(exitStub.callCount, 'process.exit should be called only once').to.equal(1);
        });
        it('still exits if container cleanup rejects', async () => {
            const container = createTestContainer();
            const cleanupError = new Error('cleanup boom');
            sandbox.stub(container, 'unbindAllAsync').rejects(cleanupError);
            const mockLogger = container.get(common_1.ILogger);
            const warnStub = sandbox.stub(mockLogger, 'warn');
            const app = container.get(TestBackendApplication);
            await app.invokeGracefulShutdown();
            (0, chai_1.expect)(exitStub.calledOnceWith(1), 'process.exit(1) was not called').to.be.true;
            (0, chai_1.expect)(warnStub.calledOnce, 'a warning should be logged when cleanup rejects').to.be.true;
            (0, chai_1.expect)(warnStub.firstCall.args[0]).to.match(/cleanup boom/);
        });
        it('exits even when container cleanup hangs past the timeout', async () => {
            const clock = sandbox.useFakeTimers();
            const container = createTestContainer();
            sandbox.stub(container, 'unbindAllAsync').returns(new Promise(() => { }));
            const mockLogger = container.get(common_1.ILogger);
            const warnStub = sandbox.stub(mockLogger, 'warn');
            const app = container.get(TestBackendApplication);
            const shutdownPromise = app.invokeGracefulShutdown();
            await clock.tickAsync(5001);
            await shutdownPromise;
            (0, chai_1.expect)(exitStub.calledOnceWith(1), 'process.exit(1) was not called after timeout').to.be.true;
            (0, chai_1.expect)(warnStub.calledOnce, 'a warning should be logged on timeout').to.be.true;
            (0, chai_1.expect)(warnStub.firstCall.args[0]).to.match(/timed out/);
        });
        it('awaits async onStop contributions before unbinding the container', async () => {
            const container = createTestContainer();
            const onStopDeferred = new promise_util_1.Deferred();
            container.bind(backend_application_1.BackendApplicationContribution).toConstantValue({
                onStop: () => onStopDeferred.promise
            });
            const unbindSpy = sandbox.spy(container, 'unbindAllAsync');
            const app = container.get(TestBackendApplication);
            const shutdownPromise = app.invokeGracefulShutdown();
            (0, chai_1.expect)(unbindSpy.called, 'unbindAllAsync should not run before onStop resolves').to.be.false;
            onStopDeferred.resolve();
            await shutdownPromise;
            (0, chai_1.expect)(unbindSpy.calledOnce, 'unbindAllAsync should run once onStop completes').to.be.true;
            (0, chai_1.expect)(exitStub.calledOnceWith(1)).to.be.true;
        });
        it('invokes onStop hooks while injected services are still resolvable', async () => {
            let Helper = class Helper {
                constructor() {
                    this.value = 'still-bound';
                }
            };
            Helper = tslib_1.__decorate([
                (0, inversify_1.injectable)()
            ], Helper);
            const container = createTestContainer();
            container.bind(Helper).toSelf().inSingletonScope();
            let observed;
            container.bind(backend_application_1.BackendApplicationContribution).toConstantValue({
                onStop: () => {
                    observed = container.get(Helper).value;
                }
            });
            const app = container.get(TestBackendApplication);
            await app.invokeGracefulShutdown();
            (0, chai_1.expect)(observed, 'onStop should observe injected services that are still bound').to.equal('still-bound');
        });
        it('proceeds with shutdown when onStop hooks exceed the timeout', async () => {
            const clock = sandbox.useFakeTimers();
            const container = createTestContainer();
            container.bind(backend_application_1.BackendApplicationContribution).toConstantValue({
                onStop: () => new Promise(() => { })
            });
            const unbindSpy = sandbox.spy(container, 'unbindAllAsync');
            const mockLogger = container.get(common_1.ILogger);
            const warnStub = sandbox.stub(mockLogger, 'warn');
            const app = container.get(TestBackendApplication);
            const shutdownPromise = app.invokeGracefulShutdown();
            await clock.tickAsync(5001);
            await shutdownPromise;
            (0, chai_1.expect)(warnStub.calledOnce, 'a warning should be logged on onStop timeout').to.be.true;
            (0, chai_1.expect)(warnStub.firstCall.args[0]).to.match(/Stopping backend contributions/);
            (0, chai_1.expect)(unbindSpy.calledOnce, 'unbind should still run after onStop times out').to.be.true;
            (0, chai_1.expect)(exitStub.calledOnceWith(1)).to.be.true;
        });
        it('runs all contributions even when one onStop rejects', async () => {
            const container = createTestContainer();
            let secondRan = false;
            container.bind(backend_application_1.BackendApplicationContribution).toConstantValue({
                onStop: async () => { throw new Error('boom'); }
            });
            container.bind(backend_application_1.BackendApplicationContribution).toConstantValue({
                onStop: () => { secondRan = true; }
            });
            const mockLogger = container.get(common_1.ILogger);
            const errorStub = sandbox.stub(mockLogger, 'error');
            const app = container.get(TestBackendApplication);
            await app.invokeGracefulShutdown();
            (0, chai_1.expect)(secondRan, 'second contribution should still be stopped after first rejects').to.be.true;
            (0, chai_1.expect)(errorStub.calledWithMatch('Could not stop contribution')).to.be.true;
        });
        it('is idempotent when a contribution re-enters graceful shutdown', async () => {
            const container = createTestContainer();
            // Indirected through a holder so the contribution closure can refer to the
            // application instance that is constructed after the binding is recorded.
            const appHolder = {};
            container.bind(backend_application_1.BackendApplicationContribution).toConstantValue({
                onStop: () => appHolder.current.invokeGracefulShutdown()
            });
            const unbindSpy = sandbox.spy(container, 'unbindAllAsync');
            appHolder.current = container.get(TestBackendApplication);
            await appHolder.current.invokeGracefulShutdown();
            (0, chai_1.expect)(unbindSpy.callCount, 'unbindAllAsync should be called only once').to.equal(1);
            (0, chai_1.expect)(exitStub.callCount, 'process.exit should be called only once').to.equal(1);
        });
    });
    describe('process exit handler', () => {
        it('does not re-invoke contributions after graceful shutdown ran them', async () => {
            const container = createTestContainer();
            const onStopSpy = sandbox.spy();
            container.bind(backend_application_1.BackendApplicationContribution).toConstantValue({ onStop: onStopSpy });
            const terminateStub = sandbox.stub(process_utils_1.ProcessUtils.prototype, 'terminateProcessTree');
            const app = container.get(TestBackendApplication);
            const exitListener = process.listeners('exit')[0];
            await app.invokeGracefulShutdown();
            (0, chai_1.expect)(onStopSpy.callCount, 'contribution onStop should fire from gracefulShutdown').to.equal(1);
            exitListener();
            (0, chai_1.expect)(onStopSpy.callCount, 'contribution onStop should not be invoked a second time').to.equal(1);
            (0, chai_1.expect)(terminateStub.called, 'terminateProcessTree should be invoked by the exit handler').to.be.true;
        });
        it('invokes contributions synchronously when graceful shutdown was bypassed', () => {
            const container = createTestContainer();
            const onStopSpy = sandbox.spy();
            container.bind(backend_application_1.BackendApplicationContribution).toConstantValue({ onStop: onStopSpy });
            const terminateStub = sandbox.stub(process_utils_1.ProcessUtils.prototype, 'terminateProcessTree');
            container.get(TestBackendApplication);
            const exitListener = process.listeners('exit')[0];
            exitListener();
            (0, chai_1.expect)(onStopSpy.calledOnce, 'sync exit path should still invoke contributions').to.be.true;
            (0, chai_1.expect)(terminateStub.called, 'terminateProcessTree should be invoked').to.be.true;
        });
    });
});
//# sourceMappingURL=backend-application.spec.js.map