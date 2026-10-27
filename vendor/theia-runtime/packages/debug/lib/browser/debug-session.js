"use strict";
var DebugSession_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.DebugSession = exports.DebugState = exports.DebugSessionStopTimeout = exports.DebugSessionData = void 0;
exports.debugStateContextValue = debugStateContextValue;
exports.formatMessage = formatMessage;
const tslib_1 = require("tslib");
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
const browser_1 = require("@theia/core/lib/browser");
const common_1 = require("@theia/core/lib/common");
const inversify_1 = require("@theia/core/shared/inversify");
const terminal_service_1 = require("@theia/terminal/lib/browser/base/terminal-service");
const browser_2 = require("@theia/editor/lib/browser");
const debug_session_connection_1 = require("./debug-session-connection");
const debug_thread_1 = require("./model/debug-thread");
const debug_source_1 = require("./model/debug-source");
const debounce = require("p-debounce");
const uri_1 = require("@theia/core/lib/common/uri");
const breakpoint_manager_1 = require("./breakpoint/breakpoint-manager");
const debug_session_options_1 = require("./debug-session-options");
const debug_common_1 = require("../common/debug-common");
const breakpoint_marker_1 = require("./breakpoint/breakpoint-marker");
const file_service_1 = require("@theia/filesystem/lib/browser/file-service");
const debug_contribution_1 = require("./debug-contribution");
const promise_util_1 = require("@theia/core/lib/common/promise-util");
const browser_3 = require("@theia/workspace/lib/browser");
const core_1 = require("@theia/core");
const test_service_1 = require("@theia/test/lib/browser/test-service");
const debug_session_manager_1 = require("./debug-session-manager");
const debug_preferences_1 = require("../common/debug-preferences");
exports.DebugSessionData = Symbol('DebugSessionData');
exports.DebugSessionStopTimeout = Symbol('DebugSessionStopTimeout');
var DebugState;
(function (DebugState) {
    DebugState[DebugState["Inactive"] = 0] = "Inactive";
    DebugState[DebugState["Initializing"] = 1] = "Initializing";
    DebugState[DebugState["Running"] = 2] = "Running";
    DebugState[DebugState["Stopped"] = 3] = "Stopped";
})(DebugState || (exports.DebugState = DebugState = {}));
/**
 * The mapped string values must not change as they are used for the `debugState` when context closure.
 * For more details see the `Debugger contexts` section of the [official doc](https://code.visualstudio.com/api/references/when-clause-contexts#available-contexts).
 */
function debugStateContextValue(state) {
    switch (state) {
        case DebugState.Initializing: return 'initializing';
        case DebugState.Stopped: return 'stopped';
        case DebugState.Running: return 'running';
        default: return 'inactive';
    }
}
const formatMessageRegexp = /\{([^}]+)\}/g;
/**
 * Returns a formatted message string. The format is compatible with {@link DebugProtocol.Message.format}.
 * @param format A format string for the message. Embedded variables have the form `{name}`.
 * @param variables An object used as a dictionary for looking up the variables in the format string.
 */
function formatMessage(format, variables) {
    return variables ? format.replace(formatMessageRegexp, (match, group) => variables.hasOwnProperty(group) ? variables[group] : match) : format;
}
let DebugSession = DebugSession_1 = class DebugSession {
    constructor() {
        this.deferredOnDidConfigureCapabilities = new promise_util_1.Deferred();
        this.onDidChangeEmitter = new common_1.Emitter();
        this.onDidChange = this.onDidChangeEmitter.event;
        this.onDidFocusStackFrameEmitter = new common_1.Emitter();
        this.onDidFocusThreadEmitter = new common_1.Emitter();
        this.onDidResolveLazyVariableEmitter = new common_1.Emitter();
        this.onDidResolveLazyVariable = this.onDidResolveLazyVariableEmitter.event;
        this.childSessions = new Map();
        this.toDispose = new common_1.DisposableCollection();
        this.isStopping = false;
        /** Maximum time to wait for the shell integration prompt before proceeding. */
        this.PROMPT_READY_TIMEOUT_MS = 3000;
        this._capabilities = {};
        this.sources = new Map();
        this._threads = new Map();
        this.toDisposeOnCurrentThread = new common_1.DisposableCollection();
        /**
         * The `send('initialize')` request could resolve later than `on('initialized')` emits the event.
         * Hence, the `configure` would use the empty object `capabilities`.
         * Using the empty `capabilities` could result in missing exception breakpoint filters, as
         * always `capabilities.exceptionBreakpointFilters` is falsy. This deferred promise works
         * around this timing issue. https://github.com/eclipse-theia/theia/issues/11886
         */
        this.didReceiveCapabilities = new promise_util_1.Deferred();
        this.initialized = false;
        this.scheduleUpdateThreads = debounce(() => this.updateThreads(undefined), 100);
        this.pendingThreads = Promise.resolve();
        this.updatingBreakpoints = false;
    }
    static createContainer(parent, data, connection) {
        const child = parent.createChild();
        child.bind(exports.DebugSessionData).toConstantValue(data);
        child.bind(exports.DebugSessionStopTimeout).toConstantValue(5_000);
        child.bind(debug_session_connection_1.DebugSessionConnection).toConstantValue(connection);
        child.bind(DebugSession_1).toSelf().inSingletonScope();
        return child;
    }
    get id() {
        return this.data.id;
    }
    get options() {
        return this.data.options;
    }
    get parentSession() {
        return this.data.parentSession;
    }
    fireDidChange() {
        this.onDidChangeEmitter.fire(undefined);
    }
    get onDidFocusStackFrame() {
        return this.onDidFocusStackFrameEmitter.event;
    }
    get onDidFocusThread() {
        return this.onDidFocusThreadEmitter.event;
    }
    init() {
        this.connection.onRequest('runInTerminal', (request) => this.runInTerminal(request));
        this.connection.onDidClose(() => {
            this.toDispose.dispose();
        });
        this.registerDebugContributions(this.options.configuration.type, this.connection);
        if (this.parentSession) {
            this.parentSession.childSessions.set(this.id, this);
            this.toDispose.push(common_1.Disposable.create(() => {
                this.parentSession?.childSessions?.delete(this.id);
            }));
        }
        if (this.options.testRun) {
            try {
                const run = test_service_1.TestServices.withTestRun(this.testService, this.options.testRun.controllerId, this.options.testRun.runId);
                run.onDidChangeProperty(evt => {
                    if (evt.isRunning === false) {
                        this.sessionManager.terminateSession(this);
                    }
                });
            }
            catch (err) {
                this.logger.error(err);
            }
        }
        this.connection.onDidClose(() => this.toDispose.dispose());
        this.toDispose.pushAll([
            this.onDidChangeEmitter,
            this.onDidFocusStackFrameEmitter,
            this.onDidFocusThreadEmitter,
            this.onDidResolveLazyVariableEmitter,
            common_1.Disposable.create(() => {
                this.doUpdateThreads([]);
            }),
            this.connection,
            this.connection.on('initialized', () => this.configure()),
            this.connection.on('breakpoint', ({ body }) => this.updateBreakpoint(body)),
            this.connection.on('continued', e => this.handleContinued(e)),
            this.connection.on('stopped', e => this.handleStopped(e)),
            this.connection.on('thread', e => this.handleThread(e)),
            this.connection.on('capabilities', event => this.updateCapabilities(event.body.capabilities)),
            this.breakpoints.onDidChangeMarkers(uri => this.updateBreakpoints({ uri, sourceModified: true }))
        ]);
    }
    get onDispose() {
        return this.toDispose.onDispose;
    }
    get configuration() {
        return this.options.configuration;
    }
    get capabilities() {
        return this._capabilities;
    }
    get autoExpandLazyVariables() {
        return this.debugPreferences['debug.autoExpandLazyVariables'] === 'on';
    }
    getSource(raw) {
        const uri = debug_source_1.DebugSource.toUri(raw).toString();
        const source = this.sources.get(uri) || new debug_source_1.DebugSource(this, this.editorManager, this.labelProvider);
        source.update({ raw });
        this.sources.set(uri, source);
        return source;
    }
    getSourceForUri(uri) {
        return this.sources.get(uri.toString());
    }
    async toSource(uri) {
        const source = this.getSourceForUri(uri);
        if (source) {
            return source;
        }
        return this.getSource(await this.toDebugSource(uri));
    }
    async toDebugSource(uri) {
        if (uri.scheme === debug_source_1.DebugSource.SCHEME) {
            return {
                name: uri.path.toString(),
                sourceReference: Number(uri.query)
            };
        }
        const name = this.labelProvider.getName(uri);
        let path;
        const underlying = await this.fileService.toUnderlyingResource(uri);
        if (underlying.scheme === 'file') {
            path = await this.fileService.fsPath(underlying);
        }
        else {
            path = uri.toString();
        }
        return { name, path };
    }
    get threads() {
        return this._threads.values();
    }
    get threadCount() {
        return this._threads.size;
    }
    *getThreads(filter) {
        for (const thread of this.threads) {
            if (filter(thread)) {
                yield thread;
            }
        }
    }
    get runningThreads() {
        return this.getThreads(thread => !thread.stopped);
    }
    get stoppedThreads() {
        return this.getThreads(thread => thread.stopped);
    }
    async pauseAll() {
        const promises = [];
        for (const thread of this.runningThreads) {
            promises.push((async () => {
                try {
                    await thread.pause();
                }
                catch (e) {
                    this.logger.error('pauseAll failed:', e);
                }
            })());
        }
        await Promise.all(promises);
    }
    async continueAll() {
        const promises = [];
        for (const thread of this.stoppedThreads) {
            promises.push((async () => {
                try {
                    await thread.continue();
                }
                catch (e) {
                    this.logger.error('continueAll failed:', e);
                }
            })());
        }
        await Promise.all(promises);
    }
    get currentFrame() {
        return this.currentThread && this.currentThread.currentFrame;
    }
    get currentThread() {
        return this._currentThread;
    }
    set currentThread(thread) {
        if (this._currentThread?.id === thread?.id) {
            return;
        }
        this.toDisposeOnCurrentThread.dispose();
        this._currentThread = thread;
        this.onDidFocusThreadEmitter.fire(thread);
        this.fireDidChange();
        if (thread) {
            this.toDisposeOnCurrentThread.push(thread.onDidChanged(() => this.fireDidChange()));
            this.toDisposeOnCurrentThread.push(thread.onDidFocusStackFrame(frame => this.onDidFocusStackFrameEmitter.fire(frame)));
            // If this thread is missing stack frame information, then load that.
            this.updateFrames();
        }
    }
    get state() {
        if (this.connection.disposed) {
            return DebugState.Inactive;
        }
        if (!this.initialized) {
            return DebugState.Initializing;
        }
        const thread = this.currentThread;
        if (thread) {
            return thread.stopped ? DebugState.Stopped : DebugState.Running;
        }
        return !!this.stoppedThreads.next().value ? DebugState.Stopped : DebugState.Running;
    }
    async getScopes() {
        const { currentFrame } = this;
        return currentFrame ? currentFrame.getScopes() : [];
    }
    showMessage(messageType, message) {
        this.messages.showMessage({
            type: messageType,
            text: message,
            options: {
                timeout: 10000
            }
        });
    }
    async start() {
        await this.initialize();
        await this.launchOrAttach();
    }
    async initialize() {
        try {
            const response = await this.connection.sendRequest('initialize', {
                clientID: 'Theia',
                clientName: core_1.nls.localize('theia/debug/TheiaIDE', 'Theia IDE'),
                adapterID: this.configuration.type,
                locale: 'en-US',
                linesStartAt1: true,
                columnsStartAt1: true,
                pathFormat: 'path',
                supportsVariableType: false,
                supportsVariablePaging: false,
                supportsRunInTerminalRequest: true
            });
            this.updateCapabilities(response?.body || {});
            this.didReceiveCapabilities.resolve();
        }
        catch (err) {
            this.didReceiveCapabilities.reject(err);
            throw err;
        }
    }
    async launchOrAttach() {
        try {
            await this.sendRequest(this.configuration.request, this.configuration);
        }
        catch (reason) {
            this.showMessage(common_1.MessageType.Error, reason.message || core_1.nls.localize('theia/debug/debugSessionInitializationFailed', 'Debug session initialization failed. See console for details.'));
            throw reason;
        }
    }
    async configure() {
        await this.didReceiveCapabilities.promise;
        if (this.capabilities.exceptionBreakpointFilters) {
            this.breakpoints.addExceptionBreakpoints(this.capabilities.exceptionBreakpointFilters, this.id);
        }
        // mark as initialized, so updated breakpoints are shown in editor
        this.initialized = true;
        await this.updateBreakpoints({ sourceModified: false });
        if (this.capabilities.supportsConfigurationDoneRequest) {
            await this.sendRequest('configurationDone', {});
        }
        await this.updateThreads(undefined);
    }
    canTerminate() {
        return !!this.capabilities.supportsTerminateRequest;
    }
    canRestart() {
        return !!this.capabilities.supportsRestartRequest;
    }
    async restart() {
        if (this.canRestart()) {
            await this.sendRequest('restart', {});
        }
    }
    async stop(isRestart, callback) {
        if (!this.isStopping) {
            this.isStopping = true;
            if (this.canTerminate()) {
                const terminated = this.waitFor('terminated', this.stopTimeout);
                try {
                    await this.connection.sendRequest('terminate', { restart: isRestart }, this.stopTimeout);
                    await terminated;
                }
                catch (e) {
                    this.handleTerminateError(e);
                }
            }
            else {
                const terminateDebuggee = this.initialized && this.capabilities.supportTerminateDebuggee;
                try {
                    await this.sendRequest('disconnect', { restart: isRestart, terminateDebuggee }, this.stopTimeout);
                }
                catch (e) {
                    this.handleDisconnectError(e);
                }
            }
            callback();
        }
    }
    /**
     * Invoked when sending the `terminate` request to the debugger is rejected or timed out.
     */
    handleTerminateError(err) {
        this.logger.error('Did not receive terminated event in time', err);
    }
    /**
     * Invoked when sending the `disconnect` request to the debugger is rejected or timed out.
     */
    handleDisconnectError(err) {
        this.logger.error('Error on disconnect', err);
    }
    async disconnect(isRestart, callback) {
        if (!this.isStopping) {
            this.isStopping = true;
            await this.sendRequest('disconnect', { restart: isRestart });
            callback();
        }
    }
    async completions(text, column, line) {
        const frameId = this.currentFrame && this.currentFrame.raw.id;
        const response = await this.sendRequest('completions', { frameId, text, column, line });
        return response.body.targets;
    }
    async evaluate(expression, context) {
        const frameId = this.currentFrame && this.currentFrame.raw.id;
        const response = await this.sendRequest('evaluate', { expression, frameId, context });
        return response.body;
    }
    sendRequest(command, args, timeout) {
        return this.connection.sendRequest(command, args, timeout);
    }
    sendCustomRequest(command, args) {
        return this.connection.sendCustomRequest(command, args);
    }
    on(kind, listener) {
        return this.connection.on(kind, listener);
    }
    waitFor(kind, ms) {
        return (0, promise_util_1.waitForEvent)(this.connection.onEvent(kind), ms).then();
    }
    get onDidCustomEvent() {
        return this.connection.onDidCustomEvent;
    }
    async runInTerminal({ arguments: { title, cwd, args, env } }) {
        const terminal = await this.doCreateTerminal({ title, cwd, env, useServerTitle: false });
        const { processId } = terminal;
        await terminal.executeCommand({ cwd, args, env });
        return { processId: await processId };
    }
    async doCreateTerminal(options) {
        let terminal = undefined;
        for (const t of this.terminalServer.all) {
            if ((t.title.label === options.title || t.title.caption === options.title) && (await t.hasChildProcesses()) === false) {
                terminal = t;
                break;
            }
        }
        if (!terminal) {
            terminal = await this.terminalServer.newTerminal({ ...options, kind: 'debug' });
            await terminal.start();
            try {
                if (terminal.commandHistoryState) {
                    // delay opening of the terminal until the terminal prompt appears to prevent duplicate commands in the terminal buffer
                    await (0, promise_util_1.waitForEvent)(terminal.commandHistoryState.onTerminalPromptShown, this.PROMPT_READY_TIMEOUT_MS);
                }
            }
            catch (error) {
                if (error instanceof common_1.CancellationError) {
                    this.logger.warn('Shell integration did not emit a prompt within the timeout; proceeding anyway.');
                }
                else {
                    this.logger.error('Unexpected error while waiting for terminal prompt:', error);
                    throw error;
                }
            }
        }
        this.terminalServer.open(terminal);
        return terminal;
    }
    clearThreads() {
        for (const thread of this.threads) {
            thread.clear();
        }
        this.updateCurrentThread();
    }
    clearThread(threadId) {
        const thread = this._threads.get(threadId);
        if (thread) {
            thread.clear();
        }
        this.updateCurrentThread();
    }
    updateThreads(stoppedDetails) {
        return this.pendingThreads = this.pendingThreads.then(async () => {
            try {
                const response = await this.sendRequest('threads', {});
                // java debugger returns an empty body sometimes
                const threads = response && response.body && response.body.threads || [];
                this.doUpdateThreads(threads, stoppedDetails);
            }
            catch (e) {
                this.logger.error('updateThreads failed:', e);
            }
        });
    }
    doUpdateThreads(threads, stoppedDetails) {
        const existing = this._threads;
        this._threads = new Map();
        for (const raw of threads) {
            const id = raw.id;
            const thread = existing.get(id) || new debug_thread_1.DebugThread(this);
            this._threads.set(id, thread);
            const data = { raw };
            if (stoppedDetails) {
                if (stoppedDetails.threadId === id) {
                    data.stoppedDetails = stoppedDetails;
                }
                else if (stoppedDetails.allThreadsStopped) {
                    data.stoppedDetails = {
                        // When a debug adapter notifies us that all threads are stopped,
                        // we do not know why the others are stopped, so we should default
                        // to something generic.
                        reason: '',
                    };
                }
            }
            thread.update(data);
        }
        this.updateCurrentThread(stoppedDetails);
    }
    updateCurrentThread(stoppedDetails) {
        const { currentThread } = this;
        let threadId = currentThread && currentThread.raw.id;
        if (stoppedDetails && !stoppedDetails.preserveFocusHint && !!stoppedDetails.threadId) {
            threadId = stoppedDetails.threadId;
        }
        this.currentThread = typeof threadId === 'number' && this._threads.get(threadId)
            || this._threads.values().next().value;
    }
    async updateFrames() {
        const thread = this._currentThread;
        if (!thread || thread.pendingFrameCount || thread.frameCount) {
            return;
        }
        if (this.capabilities.supportsDelayedStackTraceLoading) {
            await thread.fetchFrames(1);
            await thread.fetchFrames(19);
        }
        else {
            await thread.fetchFrames();
        }
    }
    updateCapabilities(capabilities) {
        Object.assign(this._capabilities, capabilities);
        this.deferredOnDidConfigureCapabilities.resolve();
    }
    updateBreakpoint(body) {
        this.updatingBreakpoints = true;
        try {
            const raw = body.breakpoint;
            if (body.reason === 'new') {
                if (raw.source && typeof raw.line === 'number') {
                    const uri = debug_source_1.DebugSource.toUri(raw.source);
                    const origin = breakpoint_marker_1.SourceBreakpoint.create(uri, { line: raw.line, column: raw.column });
                    const breakpoint = this.breakpoints.addBreakpoint(origin);
                    this.breakpoints.updateSessionData(this.id, this.capabilities, new Map([[breakpoint.id, raw]]));
                }
            }
            if (body.reason === 'removed' && typeof raw.id === 'number') {
                const toRemove = this.findBreakpoint(b => b.getIdForSession(this.id) === raw.id);
                if (toRemove) {
                    toRemove.remove();
                }
            }
            if (body.reason === 'changed' && typeof raw.id === 'number') {
                const toUpdate = this.findBreakpoint(b => b.getIdForSession(this.id) === raw.id);
                if (toUpdate) {
                    this.breakpoints.updateSessionData(this.id, this.capabilities, new Map([[toUpdate.id, raw]]));
                }
            }
        }
        finally {
            this.updatingBreakpoints = false;
        }
    }
    findBreakpoint(match) {
        for (const bp of this.breakpoints.allBreakpoints()) {
            if (match(bp)) {
                return bp;
            }
        }
    }
    async updateBreakpoints(options) {
        if (this.updatingBreakpoints) {
            return;
        }
        const { uri, sourceModified } = options;
        await this.deferredOnDidConfigureCapabilities.promise;
        for (const affectedUri of this.getAffectedUris(uri)) {
            if (affectedUri.toString() === breakpoint_manager_1.BreakpointManager.EXCEPTION_URI.toString()) {
                await this.sendExceptionBreakpoints();
            }
            else if (affectedUri.toString() === breakpoint_manager_1.BreakpointManager.FUNCTION_URI.toString()) {
                await this.sendFunctionBreakpoints(affectedUri);
            }
            else if (affectedUri.toString() === breakpoint_manager_1.BreakpointManager.INSTRUCTION_URI.toString()) {
                await this.sendInstructionBreakpoints();
            }
            else if (affectedUri.isEqual(breakpoint_manager_1.BreakpointManager.DATA_URI)) {
                await this.sendDataBreakpoints();
            }
            else {
                await this.sendSourceBreakpoints(affectedUri, sourceModified);
            }
        }
    }
    async sendExceptionBreakpoints() {
        const filters = [];
        const filterOptions = this.capabilities.supportsExceptionFilterOptions ? [] : undefined;
        const toSend = this.breakpoints.getExceptionBreakpoints().filter(candidate => candidate.origin.enabled);
        const updates = new Map();
        for (const breakpoint of toSend) {
            if (filterOptions) {
                filterOptions.push({
                    filterId: breakpoint.origin.raw.filter,
                    condition: breakpoint.origin.condition
                });
            }
            else {
                filters.push(breakpoint.origin.raw.filter);
            }
        }
        try {
            const res = await this.sendRequest('setExceptionBreakpoints', { filters, filterOptions });
            res.body?.breakpoints?.forEach((bp, index) => toSend[index] && updates.set(toSend[index].id, bp));
        }
        catch (err) {
            this.logger.error('Failed to set exception breakpoints:', err);
            const message = err?.message ? `${err.message}` : 'Failed to set exception breakpoints.';
            toSend.forEach(bp => updates.set(bp.id, { verified: false, message }));
        }
        this.breakpoints.updateSessionData(this.id, this.capabilities, updates);
    }
    async sendFunctionBreakpoints(affectedUri) {
        if (!this.capabilities.supportsFunctionBreakpoints) {
            return;
        }
        const all = this.breakpoints.getFunctionBreakpoints();
        const enabled = all.filter(b => b.enabled);
        const updates = new Map();
        try {
            const response = await this.sendRequest('setFunctionBreakpoints', {
                breakpoints: enabled.map(b => b.origin.raw)
            });
            // Apparently, `body` and `breakpoints` can be missing.
            // https://github.com/eclipse-theia/theia/issues/11885
            // https://github.com/microsoft/vscode/blob/80004351ccf0884b58359f7c8c801c91bb827d83/src/vs/workbench/contrib/debug/browser/debugSession.ts#L448-L449
            response?.body?.breakpoints.forEach((raw, index) => {
                // node debug adapter returns more breakpoints sometimes
                if (enabled[index]) {
                    updates.set(enabled[index].id, raw);
                }
            });
        }
        catch (error) {
            const genericMessage = 'Function breakpoint not valid for current debug session';
            const message = error.message ? `${error.message}` : genericMessage;
            this.logger.warn(`Could not handle function breakpoints: ${message}, disabling...`);
            enabled.forEach(b => updates.set(b.id, { verified: false, message }));
        }
        this.breakpoints.updateSessionData(this.id, this.capabilities, updates);
    }
    async sendSourceBreakpoints(affectedUri, sourceModified) {
        const source = await this.toSource(affectedUri);
        const all = this.breakpoints.getBreakpoints(affectedUri);
        const enabled = all.filter(b => b.enabled);
        const updates = new Map();
        try {
            const breakpoints = enabled.map(({ origin }) => origin.raw);
            const response = await this.sendRequest('setBreakpoints', {
                source: source.raw,
                sourceModified,
                breakpoints,
                lines: breakpoints.map(({ line }) => line)
            });
            response.body.breakpoints.forEach((raw, index) => {
                // node debug adapter returns more breakpoints sometimes
                if (enabled[index]) {
                    updates.set(enabled[index].id, raw);
                }
            });
        }
        catch (error) {
            // could be error or promise rejection of DebugProtocol.SetBreakpointsResponse
            if (error instanceof Error) {
                this.logger.error(`Error setting breakpoints: ${error.message}`);
            }
            else {
                // handle adapters that send failed DebugProtocol.SetBreakpointsResponse for invalid breakpoints
                const genericMessage = 'Breakpoint not valid for current debug session';
                const message = error.message ? `${error.message}` : genericMessage;
                this.logger.warn(`Could not handle breakpoints for ${affectedUri}: ${message}, disabling...`);
                enabled.forEach(b => updates.set(b.id, { verified: false, message }));
            }
        }
        this.breakpoints.updateSessionData(this.id, this.capabilities, updates);
    }
    async sendInstructionBreakpoints() {
        if (!this.capabilities.supportsInstructionBreakpoints) {
            return;
        }
        const all = this.breakpoints.getInstructionBreakpoints();
        const enabled = all.filter(breakpoint => breakpoint.enabled);
        const updates = new Map();
        try {
            const response = await this.sendRequest('setInstructionBreakpoints', {
                breakpoints: enabled.map(renderable => renderable.origin.raw),
            });
            response.body.breakpoints.forEach((raw, index) => enabled[index] && updates.set(enabled[index].id, raw));
        }
        catch {
            enabled.forEach(breakpoint => updates.set(breakpoint.id, { verified: false }));
        }
        this.breakpoints.updateSessionData(this.id, this.capabilities, updates);
    }
    async sendDataBreakpoints() {
        if (!this.capabilities.supportsDataBreakpoints) {
            return;
        }
        const all = this.breakpoints.getDataBreakpoints();
        const enabled = all.filter(bp => bp.enabled);
        const updates = new Map();
        try {
            const response = await this.sendRequest('setDataBreakpoints', {
                breakpoints: enabled.map(({ origin }) => origin.raw)
            });
            response.body.breakpoints.forEach((raw, index) => enabled[index] && updates.set(enabled[index].id, raw));
        }
        catch {
            enabled.forEach(breakpoint => updates.set(breakpoint.id, { verified: false }));
        }
        this.breakpoints.updateSessionData(this.id, this.capabilities, updates);
    }
    *getAffectedUris(uri) {
        if (uri) {
            yield uri;
        }
        else {
            for (const uriString of this.breakpoints.getUris()) {
                yield new uri_1.default(uriString);
            }
            yield breakpoint_manager_1.BreakpointManager.FUNCTION_URI;
            yield breakpoint_manager_1.BreakpointManager.EXCEPTION_URI;
            yield breakpoint_manager_1.BreakpointManager.DATA_URI;
        }
    }
    get label() {
        const suffixes = [];
        if (debug_session_options_1.InternalDebugSessionOptions.is(this.options) && this.options.id) {
            suffixes.push(String(this.options.id + 1));
        }
        if (this.workspaceService.isMultiRootWorkspaceOpened && this.options.workspaceFolderUri) {
            suffixes.push(this.labelProvider.getName(new uri_1.default(this.options.workspaceFolderUri)));
        }
        return suffixes.length === 0 ? this.configuration.name : this.configuration.name + ` (${suffixes.join(' - ')})`;
    }
    get visible() {
        return this.state > DebugState.Inactive;
    }
    render() {
        let label = '';
        const state = this.state === DebugState.Stopped ? core_1.nls.localizeByDefault('Paused') : core_1.nls.localizeByDefault('Running');
        const child = this.getSingleChildSession();
        if (child && child.configuration.compact) {
            // Inlines the name of the child debug session
            label = `: ${child.label}`;
        }
        return (0, jsx_runtime_1.jsxs)("div", { className: 'theia-debug-session', title: 'Session', children: [(0, jsx_runtime_1.jsx)("span", { className: 'label', children: this.label + label }), (0, jsx_runtime_1.jsx)("span", { className: 'status', children: state })] });
    }
    *getElements() {
        const child = this.getSingleChildSession();
        if (child && child.configuration.compact) {
            // Inlines the elements of the child debug session
            return yield* child.getElements();
        }
        yield* this.threads;
        yield* this.childSessions.values();
    }
    getSingleChildSession() {
        if (this._threads.size === 0 && this.childSessions.size === 1) {
            const child = this.childSessions.values().next().value;
            return child;
        }
        return undefined;
    }
    async handleContinued({ body: { allThreadsContinued, threadId } }) {
        if (allThreadsContinued !== false) {
            this.clearThreads();
        }
        else {
            this.clearThread(threadId);
        }
    }
    ;
    async handleStopped({ body }) {
        // Update thread list
        await this.updateThreads(body);
        // Update current thread's frames immediately
        await this.updateFrames();
    }
    ;
    async handleThread({ body: { reason, threadId } }) {
        if (reason === 'started') {
            this.scheduleUpdateThreads();
        }
        else if (reason === 'exited') {
            this._threads.delete(threadId);
            this.updateCurrentThread();
        }
    }
    ;
    registerDebugContributions(configType, connection) {
        for (const contrib of this.debugContributionProvider.getContributions()) {
            contrib.register(configType, connection);
        }
    }
    ;
    /**
     * Returns the top-most parent session that is responsible for the console. If this session uses a {@link DebugConsoleMode.Separate separate console}
     * or does not have any parent session, undefined is returned.
     */
    findConsoleParent() {
        if (this.configuration.consoleMode !== debug_common_1.DebugConsoleMode.MergeWithParent) {
            return undefined;
        }
        let debugSession = this;
        do {
            debugSession = debugSession.parentSession;
        } while (debugSession?.parentSession && debugSession.configuration.consoleMode === debug_common_1.DebugConsoleMode.MergeWithParent);
        return debugSession;
    }
};
exports.DebugSession = DebugSession;
tslib_1.__decorate([
    (0, inversify_1.inject)(exports.DebugSessionData),
    tslib_1.__metadata("design:type", Object)
], DebugSession.prototype, "data", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_session_connection_1.DebugSessionConnection),
    tslib_1.__metadata("design:type", debug_session_connection_1.DebugSessionConnection)
], DebugSession.prototype, "connection", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(test_service_1.TestService),
    tslib_1.__metadata("design:type", Object)
], DebugSession.prototype, "testService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(new inversify_1.LazyServiceIdentifier(() => debug_session_manager_1.DebugSessionManager)),
    tslib_1.__metadata("design:type", debug_session_manager_1.DebugSessionManager)
], DebugSession.prototype, "sessionManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(terminal_service_1.TerminalService),
    tslib_1.__metadata("design:type", Object)
], DebugSession.prototype, "terminalServer", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_2.EditorManager),
    tslib_1.__metadata("design:type", browser_2.EditorManager)
], DebugSession.prototype, "editorManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(breakpoint_manager_1.BreakpointManager),
    tslib_1.__metadata("design:type", breakpoint_manager_1.BreakpointManager)
], DebugSession.prototype, "breakpoints", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.LabelProvider),
    tslib_1.__metadata("design:type", browser_1.LabelProvider)
], DebugSession.prototype, "labelProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.MessageClient),
    tslib_1.__metadata("design:type", common_1.MessageClient)
], DebugSession.prototype, "messages", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(file_service_1.FileService),
    tslib_1.__metadata("design:type", file_service_1.FileService)
], DebugSession.prototype, "fileService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.ContributionProvider),
    (0, inversify_1.named)(debug_contribution_1.DebugContribution),
    tslib_1.__metadata("design:type", Object)
], DebugSession.prototype, "debugContributionProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_3.WorkspaceService),
    tslib_1.__metadata("design:type", browser_3.WorkspaceService)
], DebugSession.prototype, "workspaceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_preferences_1.DebugPreferences),
    tslib_1.__metadata("design:type", Object)
], DebugSession.prototype, "debugPreferences", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.CommandService),
    tslib_1.__metadata("design:type", Object)
], DebugSession.prototype, "commandService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('debug:DebugSession'),
    tslib_1.__metadata("design:type", Object)
], DebugSession.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(exports.DebugSessionStopTimeout),
    tslib_1.__metadata("design:type", Number)
], DebugSession.prototype, "stopTimeout", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], DebugSession.prototype, "init", null);
exports.DebugSession = DebugSession = DebugSession_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], DebugSession);
//# sourceMappingURL=debug-session.js.map