"use strict";
// *****************************************************************************
// Copyright (C) 2017 TypeFox and others.
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
exports.BackendApplication = exports.BackendApplicationCliContribution = exports.BackendApplicationContribution = exports.BackendApplicationServer = exports.EarlyExpressMiddleware = exports.RootContainer = exports.BackendApplicationPath = void 0;
const tslib_1 = require("tslib");
const dns = require("dns");
const path = require("path");
const http = require("http");
const https = require("https");
const express = require("express");
const fs = require("fs-extra");
const inversify_1 = require("inversify");
const common_1 = require("../common");
const promise_util_1 = require("../common/promise-util");
const index_1 = require("../common/index");
const process_utils_1 = require("./process-utils");
const logger_1 = require("../common/logger");
/**
 * The path to the application project directory. This is the directory where the application code is located.
 * Mostly contains the `package.json` file and the `lib` directory.
 */
exports.BackendApplicationPath = process.env.THEIA_APP_PROJECT_PATH || process.cwd();
/**
 * Private injection token for the backend's root Inversify {@link Container}.
 */
exports.RootContainer = Symbol('RootContainer');
const APP_PROJECT_PATH = 'app-project-path';
const TIMER_WARNING_THRESHOLD = 50;
const SHUTDOWN_TIMEOUT_MS = 5000;
const DEFAULT_PORT = index_1.environment.electron.is() ? 0 : 3000;
const DEFAULT_HOST = 'localhost';
const DEFAULT_SSL = false;
const DEFAULT_DNS_DEFAULT_RESULT_ORDER = 'ipv4first';
/**
 * Shared registry for Express middleware that must run before static file handlers.
 * Contributions push handlers during `initialize()`, and `BackendApplication`
 * applies them at the start of `configure()`, before gzipped handlers and `express.static()`.
 */
let EarlyExpressMiddleware = class EarlyExpressMiddleware {
    constructor() {
        this.handlers = [];
    }
};
exports.EarlyExpressMiddleware = EarlyExpressMiddleware;
exports.EarlyExpressMiddleware = EarlyExpressMiddleware = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], EarlyExpressMiddleware);
exports.BackendApplicationServer = Symbol('BackendApplicationServer');
exports.BackendApplicationContribution = Symbol('BackendApplicationContribution');
let BackendApplicationCliContribution = class BackendApplicationCliContribution {
    constructor() {
        this.dnsDefaultResultOrder = DEFAULT_DNS_DEFAULT_RESULT_ORDER;
        /** @deprecated Use the `BackendApplicationPath` constant or `process.env.THEIA_APP_PROJECT_PATH` environment variable instead */
        this.projectPath = exports.BackendApplicationPath;
    }
    configure(conf) {
        conf.option('port', { alias: 'p', description: 'The port the backend server listens on.', type: 'number', default: DEFAULT_PORT });
        conf.option('hostname', { alias: 'h', description: 'The allowed hostname for connections.', type: 'string', default: DEFAULT_HOST });
        conf.option('ssl', { description: 'Use SSL (HTTPS), cert and certkey must also be set', type: 'boolean', default: DEFAULT_SSL });
        conf.option('cert', { description: 'Path to SSL certificate.', type: 'string' });
        conf.option('certkey', { description: 'Path to SSL certificate key.', type: 'string' });
        conf.option(APP_PROJECT_PATH, { description: 'Sets the application project directory', deprecated: true });
        conf.option('dnsDefaultResultOrder', {
            type: 'string',
            description: 'Configure Node\'s DNS resolver default behavior, see https://nodejs.org/docs/latest-v24.x/api/dns.html#dnssetdefaultresultorderorder',
            choices: ['ipv4first', 'verbatim', 'nodeDefault'],
            default: DEFAULT_DNS_DEFAULT_RESULT_ORDER
        });
    }
    setArguments(args) {
        this.port = args.port;
        this.hostname = args.hostname;
        this.ssl = args.ssl;
        this.cert = args.cert;
        this.certkey = args.certkey;
        this.dnsDefaultResultOrder = args.dnsDefaultResultOrder;
    }
};
exports.BackendApplicationCliContribution = BackendApplicationCliContribution;
exports.BackendApplicationCliContribution = BackendApplicationCliContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], BackendApplicationCliContribution);
/**
 * The main entry point for Theia applications.
 */
let BackendApplication = class BackendApplication {
    constructor(contributionsProvider, cliParams) {
        this.contributionsProvider = contributionsProvider;
        this.cliParams = cliParams;
        this.app = express();
        this.stoppedContributions = false;
        this.shuttingDown = false;
        process.on('uncaughtException', error => {
            this.handleUncaughtError(error);
        });
        // Workaround for Electron not installing a handler to ignore SIGPIPE error
        // (https://github.com/electron/electron/issues/13254)
        process.on('SIGPIPE', () => {
            this.logger.error(new Error('Unexpected SIGPIPE'));
        });
        // Handles normal process termination.
        process.on('exit', () => this.onStop());
        // Handles `Ctrl+C` and `kill pid`. Delegates to gracefulShutdown so that
        // root-scoped singletons get their @preDestroy hooks invoked before exit.
        const onSignal = () => { this.gracefulShutdown().catch(err => this.logger.error(err)); };
        process.on('SIGINT', onSignal);
        process.on('SIGTERM', onSignal);
    }
    async initialize() {
        await Promise.all(this.contributionsProvider.getContributions().map(async (contribution) => {
            if (contribution.initialize) {
                try {
                    await this.measureContribution(contribution, 'initialize', () => contribution.initialize());
                }
                catch (error) {
                    this.logger.error('Could not initialize contribution', error);
                }
            }
        }));
    }
    get configured() {
        return this._configured;
    }
    init() {
        this.settlementContext = new common_1.MeasurementContext(this.stopwatch, 'Backend', TIMER_WARNING_THRESHOLD);
        this._configured = this.configure();
    }
    async configure() {
        await this.initialize();
        // Apply early middleware before static file handlers.
        for (const handler of this.earlyMiddleware.handlers) {
            this.app.use(handler);
        }
        this.app.get('*.js', this.serveGzipped.bind(this, 'text/javascript'));
        this.app.get('*.js.map', this.serveGzipped.bind(this, 'application/json'));
        this.app.get('*.css', this.serveGzipped.bind(this, 'text/css'));
        this.app.get('*.wasm', this.serveGzipped.bind(this, 'application/wasm'));
        this.app.get('*.gif', this.serveGzipped.bind(this, 'image/gif'));
        this.app.get('*.png', this.serveGzipped.bind(this, 'image/png'));
        this.app.get('*.svg', this.serveGzipped.bind(this, 'image/svg+xml'));
        this.app.get('*.eot', this.serveGzipped.bind(this, 'application/vnd.ms-fontobject'));
        this.app.get('*.ttf', this.serveGzipped.bind(this, 'font/ttf'));
        this.app.get('*.woff', this.serveGzipped.bind(this, 'font/woff'));
        this.app.get('*.woff2', this.serveGzipped.bind(this, 'font/woff2'));
        await Promise.all(this.contributionsProvider.getContributions().map(async (contribution) => {
            if (contribution.configure) {
                try {
                    await this.measureContribution(contribution, 'configure', () => contribution.configure(this.app));
                }
                catch (error) {
                    this.logger.error('Could not configure contribution', error);
                }
            }
        }));
        this.logger.info('configured all backend app contributions');
    }
    use(...handlers) {
        this.app.use(...handlers);
    }
    async start(port, hostname) {
        const startupMeasurement = this.stopwatch.start('backend-startup');
        hostname ??= this.cliParams.hostname;
        port ??= this.cliParams.port;
        if (this.cliParams.dnsDefaultResultOrder !== 'nodeDefault') {
            dns.setDefaultResultOrder(this.cliParams.dnsDefaultResultOrder);
        }
        const deferred = new promise_util_1.Deferred();
        let server;
        if (this.cliParams.ssl) {
            if (this.cliParams.cert === undefined) {
                throw new Error('Missing --cert option, see --help for usage');
            }
            if (this.cliParams.certkey === undefined) {
                throw new Error('Missing --certkey option, see --help for usage');
            }
            let key;
            let cert;
            try {
                key = await fs.readFile(this.cliParams.certkey);
            }
            catch (err) {
                this.logger.error("Can't read certificate key");
                throw err;
            }
            try {
                cert = await fs.readFile(this.cliParams.cert);
            }
            catch (err) {
                this.logger.error("Can't read certificate");
                throw err;
            }
            server = https.createServer({ key, cert }, this.app);
        }
        else {
            server = http.createServer(this.app);
        }
        server.on('error', error => {
            deferred.reject(error);
            /* The backend might run in a separate process,
             * so we defer `process.exit` to let time for logging in the parent process */
            setTimeout(process.exit, 0, 1);
        });
        server.listen(port, hostname, () => {
            // address should be defined at this point
            const address = server.address();
            const url = typeof address === 'string' ? address : this.getHttpUrl(address, this.cliParams.ssl);
            this.logger.info(`Theia app listening on ${url}.`);
            deferred.resolve(server);
        });
        /* Allow any number of websocket servers.  */
        server.setMaxListeners(0);
        for (const contribution of this.contributionsProvider.getContributions()) {
            if (contribution.onStart) {
                try {
                    await this.measureContribution(contribution, 'onStart', () => contribution.onStart(server));
                }
                catch (error) {
                    this.logger.error('Could not start contribution', error);
                }
            }
        }
        await deferred.promise;
        startupMeasurement.info('Backend application startup sequence completed (async work may still be pending)');
        this.settlementContext?.armAllSettled();
        return server;
    }
    getHttpUrl({ address, port, family }, ssl) {
        const scheme = ssl ? 'https' : 'http';
        return family.toLowerCase() === 'ipv6'
            ? `${scheme}://[${address}]:${port}`
            : `${scheme}://${address}:${port}`;
    }
    /**
     * Performs an asynchronous shutdown of the backend in two phases:
     *
     * 1. Contributions' {@link BackendApplicationContribution.onStop onStop} hooks are
     *    dispatched in parallel and awaited so that they can still resolve services
     *    from the root Inversify container while it is bound.
     * 2. All services in the root container are unbound, running their `@preDestroy`
     *    hooks.
     *
     * Each phase has its own {@link SHUTDOWN_TIMEOUT_MS} budget to avoid hanging on a
     * misbehaving hook. Late-resolving promises from a timed-out phase may still
     * settle in the background and could log noisily or interact with a partly
     * unbound container; this is accepted because the process is exiting.
     *
     * Idempotent: a second invocation is a no-op. Exits the process with code 1 so
     * that the `process.on('exit')` handler runs for fallback cleanup such as
     * {@link ProcessUtils.terminateProcessTree}; the exit handler does not re-invoke
     * contribution `onStop()` hooks that this method already dispatched.
     */
    async gracefulShutdown() {
        if (this.shuttingDown) {
            return;
        }
        this.shuttingDown = true;
        try {
            await Promise.race([
                this.stopContributions(),
                (0, promise_util_1.timeoutReject)(SHUTDOWN_TIMEOUT_MS, `Stopping backend contributions timed out after ${SHUTDOWN_TIMEOUT_MS}ms`)
            ]);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn(`Backend contributions cleanup failed: ${message}`);
        }
        try {
            await Promise.race([
                this.rootContainer.unbindAllAsync(),
                (0, promise_util_1.timeoutReject)(SHUTDOWN_TIMEOUT_MS, `Container unbind timed out after ${SHUTDOWN_TIMEOUT_MS}ms`)
            ]);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn(`Backend root container cleanup failed: ${message}`);
        }
        process.exit(1);
    }
    async stopContributions() {
        if (this.stoppedContributions) {
            return;
        }
        this.stoppedContributions = true;
        this.logger.info('>>> Stopping backend contributions...');
        // The `async` wrapper converts a synchronous throw inside a non-async
        // contribution's `onStop` into a rejected promise so the per-contribution
        // try/catch can handle it; otherwise `Promise.all` would abort.
        await Promise.all(this.contributionsProvider.getContributions().map(async (contrib) => {
            if (contrib.onStop) {
                try {
                    await contrib.onStop(this.app);
                }
                catch (error) {
                    this.logger.error('Could not stop contribution', error);
                }
            }
        }));
        this.logger.info('<<< All backend contributions have been stopped.');
    }
    onStop() {
        // Deliberate fire-and-forget of an async `stopContributions`()` call.
        // It invokes each contribution's `onStop` synchronously up to its
        // first `await`, so any synchronous cleanup runs before
        // `terminateProcessTree`. Any returned promises are abandoned because
        // the `'exit'` event does not yield back to the event loop.
        this.stopContributions();
        this.processUtils.terminateProcessTree(process.pid);
    }
    async serveGzipped(contentType, req, res, next) {
        const acceptedEncodings = req.acceptsEncodings();
        const gzUrl = `${req.url}.gz`;
        const gzPath = path.join(exports.BackendApplicationPath, 'lib', 'frontend', gzUrl);
        if (acceptedEncodings.indexOf('gzip') === -1 || !(await fs.pathExists(gzPath))) {
            next();
            return;
        }
        req.url = gzUrl;
        res.set('Content-Encoding', 'gzip');
        res.set('Content-Type', contentType);
        next();
    }
    async measureContribution(contribution, hook, fn) {
        let innerResult;
        this.settlementContext?.ensureEntry(contribution);
        const result = await this.measure(contribution.constructor.name + '.' + hook, () => (innerResult = fn()));
        this.settlementContext?.trackSettlement(contribution, innerResult);
        return result;
    }
    async measure(name, fn) {
        return this.stopwatch.startAsync(name, `Backend ${name}`, fn, { thresholdMillis: TIMER_WARNING_THRESHOLD, defaultLogLevel: common_1.LogLevel.DEBUG });
    }
    handleUncaughtError(error) {
        if (error) {
            this.logger.error('Uncaught Exception: ', error.toString());
            if (error.stack) {
                this.logger.error(error.stack);
            }
        }
    }
};
exports.BackendApplication = BackendApplication;
tslib_1.__decorate([
    (0, inversify_1.inject)(EarlyExpressMiddleware),
    tslib_1.__metadata("design:type", EarlyExpressMiddleware)
], BackendApplication.prototype, "earlyMiddleware", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(process_utils_1.ProcessUtils),
    tslib_1.__metadata("design:type", process_utils_1.ProcessUtils)
], BackendApplication.prototype, "processUtils", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.Stopwatch),
    tslib_1.__metadata("design:type", common_1.Stopwatch)
], BackendApplication.prototype, "stopwatch", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(logger_1.ILogger),
    (0, inversify_1.named)('core:BackendApplication'),
    tslib_1.__metadata("design:type", Object)
], BackendApplication.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(exports.RootContainer),
    tslib_1.__metadata("design:type", Object)
], BackendApplication.prototype, "rootContainer", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], BackendApplication.prototype, "init", null);
exports.BackendApplication = BackendApplication = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__param(0, (0, inversify_1.inject)(common_1.ContributionProvider)),
    tslib_1.__param(0, (0, inversify_1.named)(exports.BackendApplicationContribution)),
    tslib_1.__param(1, (0, inversify_1.inject)(BackendApplicationCliContribution)),
    tslib_1.__metadata("design:paramtypes", [Object, BackendApplicationCliContribution])
], BackendApplication);
//# sourceMappingURL=backend-application.js.map