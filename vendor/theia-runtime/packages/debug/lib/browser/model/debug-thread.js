"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DebugThread = exports.DebugThreadData = void 0;
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
const core_1 = require("@theia/core");
const debug_stack_frame_1 = require("./debug-stack-frame");
class DebugThreadData {
}
exports.DebugThreadData = DebugThreadData;
class DebugThread extends DebugThreadData {
    get onDidFocusStackFrame() {
        return this.onDidFocusStackFrameEmitter.event;
    }
    constructor(session) {
        super();
        this.session = session;
        this.onDidChangedEmitter = new core_1.Emitter();
        this.onDidChanged = this.onDidChangedEmitter.event;
        this.onDidFocusStackFrameEmitter = new core_1.Emitter();
        this._frames = new Map();
        this.pendingFetch = Promise.resolve([]);
        this._pendingFetchCount = 0;
        this.pendingFetchCancel = new core_1.CancellationTokenSource();
    }
    get id() {
        return this.session.id + ':' + this.raw.id;
    }
    get threadId() {
        return this.raw.id;
    }
    get currentFrame() {
        return this._currentFrame;
    }
    set currentFrame(frame) {
        if (this._currentFrame?.id === frame?.id) {
            return;
        }
        this._currentFrame = frame;
        this.onDidChangedEmitter.fire(undefined);
        this.onDidFocusStackFrameEmitter.fire(frame);
    }
    get stopped() {
        return !!this.stoppedDetails;
    }
    update(data) {
        Object.assign(this, data);
        if ('stoppedDetails' in data) {
            this.clearFrames();
        }
    }
    clear() {
        this.update({
            raw: this.raw,
            stoppedDetails: undefined
        });
    }
    continue() {
        return this.session.sendRequest('continue', this.toArgs());
    }
    stepOver() {
        return this.session.sendRequest('next', this.toArgs());
    }
    stepIn() {
        return this.session.sendRequest('stepIn', this.toArgs());
    }
    stepOut() {
        return this.session.sendRequest('stepOut', this.toArgs());
    }
    pause() {
        return this.session.sendRequest('pause', this.toArgs());
    }
    get supportsGoto() {
        return !!this.session.capabilities.supportsGotoTargetsRequest;
    }
    async jumpToCursor(uri, position) {
        const source = await this.session?.toDebugSource(uri);
        if (!source) {
            return undefined;
        }
        const response = await this.session.sendRequest('gotoTargets', { source, line: position.lineNumber, column: position.column });
        if (response && response.body.targets.length === 0) {
            this.session.showMessage(core_1.MessageType.Warning, core_1.nls.localizeByDefault('No executable code is associated at the current cursor position.'));
            return;
        }
        const targetId = response.body.targets[0].id;
        return this.session.sendRequest('goto', this.toArgs({ targetId }));
    }
    async getExceptionInfo() {
        if (this.stoppedDetails && this.stoppedDetails.reason === 'exception') {
            if (this.session.capabilities.supportsExceptionInfoRequest) {
                const response = await this.session.sendRequest('exceptionInfo', this.toArgs());
                return {
                    id: response.body.exceptionId,
                    description: response.body.description,
                    details: response.body.details
                };
            }
            return {
                description: this.stoppedDetails.text
            };
        }
        return undefined;
    }
    get supportsTerminate() {
        return !!this.session.capabilities.supportsTerminateThreadsRequest;
    }
    async terminate() {
        if (this.supportsTerminate) {
            await this.session.sendRequest('terminateThreads', {
                threadIds: [this.raw.id]
            });
        }
    }
    get frames() {
        return this._frames.values();
    }
    get topFrame() {
        return this.frames.next().value;
    }
    get frameCount() {
        return this._frames.size;
    }
    async fetchFrames(levels = 20) {
        const cancel = this.pendingFetchCancel.token;
        this._pendingFetchCount += 1;
        return this.pendingFetch = this.pendingFetch.then(async () => {
            try {
                const start = this.frameCount;
                const frames = await this.doFetchFrames(start, levels);
                if (cancel.isCancellationRequested) {
                    return [];
                }
                return this.doUpdateFrames(start, frames);
            }
            catch (e) {
                console.error('fetchFrames failed:', e);
                return [];
            }
            finally {
                if (!cancel.isCancellationRequested) {
                    this._pendingFetchCount -= 1;
                }
            }
        });
    }
    get pendingFrameCount() {
        return this._pendingFetchCount;
    }
    async doFetchFrames(startFrame, levels) {
        try {
            const response = await this.session.sendRequest('stackTrace', this.toArgs({ startFrame, levels }));
            if (this.stoppedDetails) {
                this.stoppedDetails.totalFrames = response.body.totalFrames;
            }
            return response.body.stackFrames;
        }
        catch (e) {
            if (this.stoppedDetails) {
                this.stoppedDetails.framesErrorMessage = e.message;
            }
            return [];
        }
    }
    doUpdateFrames(startFrame, frames) {
        const result = new Set();
        frames.forEach((raw, index) => {
            // Similarly to VS Code, we no longer use `raw.frameId` in computation of the DebugStackFrame id.
            // The `raw.frameId` was changing in every step and was not allowing us to correlate stack frames between step events.
            // Refs: https://github.com/microsoft/vscode/commit/18fc2bcf718e22265b5e09bb7fd0e9c090264cd2, https://github.com/microsoft/vscode/issues/93230#issuecomment-642558395
            const source = raw.source && this.session.getSource(raw.source);
            const id = `${this.id}:${startFrame + index}:${source?.name}`;
            const frame = this._frames.get(id) || new debug_stack_frame_1.DebugStackFrame(this, this.session, id);
            this._frames.set(id, frame);
            frame.update({ raw });
            result.add(frame);
        });
        this.updateCurrentFrame();
        return [...result.values()];
    }
    clearFrames() {
        // Clear all frames
        this._frames.clear();
        // Cancel all request promises
        this.pendingFetchCancel.cancel();
        this.pendingFetchCancel = new core_1.CancellationTokenSource();
        // Empty all current requests
        this.pendingFetch = Promise.resolve([]);
        this._pendingFetchCount = 0;
        this.updateCurrentFrame();
    }
    updateCurrentFrame() {
        const { currentFrame } = this;
        const id = currentFrame && currentFrame.id;
        this.currentFrame = typeof id === 'string' &&
            this._frames.get(id) ||
            this._frames.values().next().value;
    }
    toArgs(arg) {
        return Object.assign({}, arg, {
            threadId: this.raw.id
        });
    }
    render() {
        return ((0, jsx_runtime_1.jsxs)("div", { className: "theia-debug-thread", title: core_1.nls.localizeByDefault('Session'), children: [(0, jsx_runtime_1.jsx)("span", { className: "label", children: this.raw.name }), (0, jsx_runtime_1.jsx)("span", { className: "status", children: this.threadStatus() })] }));
    }
    threadStatus() {
        if (!this.stoppedDetails) {
            return core_1.nls.localizeByDefault('Running');
        }
        const description = this.stoppedDetails.description;
        if (description) {
            // According to DAP we must show description as is. Translation is made by debug adapter
            return description;
        }
        const reason = this.stoppedDetails.reason;
        const localizedReason = this.getLocalizedReason(reason);
        return reason
            ? core_1.nls.localizeByDefault('Paused on {0}', localizedReason)
            : core_1.nls.localizeByDefault('Paused');
    }
    getLocalizedReason(reason) {
        switch (reason) {
            case 'step':
                return core_1.nls.localize('theia/debug/step', 'step');
            case 'breakpoint':
                return core_1.nls.localize('theia/debug/breakpoint', 'breakpoint');
            case 'exception':
                return core_1.nls.localize('theia/debug/exception', 'exception');
            case 'pause':
                return core_1.nls.localize('theia/debug/pause', 'pause');
            case 'entry':
                return core_1.nls.localize('theia/debug/entry', 'entry');
            case 'goto':
                return core_1.nls.localize('theia/debug/goto', 'goto');
            case 'function breakpoint':
                return core_1.nls.localize('theia/debug/functionBreakpoint', 'function breakpoint');
            case 'data breakpoint':
                return core_1.nls.localize('theia/debug/dataBreakpoint', 'data breakpoint');
            case 'instruction breakpoint':
                return core_1.nls.localize('theia/debug/instructionBreakpoint', 'instruction breakpoint');
            default:
                return '';
        }
    }
}
exports.DebugThread = DebugThread;
//# sourceMappingURL=debug-thread.js.map