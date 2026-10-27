"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DebugStackFrame = exports.DebugStackFrameData = void 0;
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
const browser_1 = require("@theia/core/lib/browser");
const browser_2 = require("@theia/editor/lib/browser");
const debug_console_items_1 = require("../console/debug-console-items");
const monaco = require("@theia/monaco-editor-core");
const hash_1 = require("@theia/core/lib/common/hash");
class DebugStackFrameData {
}
exports.DebugStackFrameData = DebugStackFrameData;
class DebugStackFrame extends DebugStackFrameData {
    constructor(thread, session, id) {
        super();
        this.thread = thread;
        this.session = session;
        this.id = id;
    }
    /**
     * Returns the frame identifier from the debug protocol.
     */
    get frameId() {
        return this.raw.id;
    }
    get source() {
        return this._source;
    }
    update(data) {
        Object.assign(this, data);
        this._source = this.raw.source && this.session.getSource(this.raw.source);
    }
    async restart() {
        await this.session.sendRequest('restartFrame', this.toArgs({
            threadId: this.thread.id
        }));
    }
    async open(options) {
        if (!this.source) {
            return undefined;
        }
        const { line, column, endLine, endColumn } = this.raw;
        const selection = {
            start: browser_2.Position.create(this.clampPositive(line - 1), this.clampPositive(column - 1))
        };
        if (typeof endLine === 'number') {
            selection.end = {
                line: this.clampPositive(endLine - 1),
                character: typeof endColumn === 'number' ? this.clampPositive(endColumn - 1) : undefined
            };
        }
        this.source.open({
            mode: 'reveal',
            ...options,
            selection
        });
    }
    /**
     * Debugger can send `column: 0` value despite of initializing the debug session with `columnsStartAt1: true`.
     * This method can be used to ensure that neither `column` nor `column` are negative numbers.
     * See https://github.com/microsoft/vscode-mock-debug/issues/85.
     */
    clampPositive(value) {
        return Math.max(value, 0);
    }
    getScopes() {
        return this.scopes || (this.scopes = this.doGetScopes());
    }
    async doGetScopes() {
        let response;
        try {
            response = await this.session.sendRequest('scopes', this.toArgs());
        }
        catch {
            // no-op: ignore debug adapter errors
        }
        if (!response) {
            return [];
        }
        const scopeIds = new Set();
        return response.body.scopes.map(raw => {
            // just as in VS Code, the id is based on the name and location to retain expansion state across multiple pauses
            let id = 0;
            do {
                id = (0, hash_1.stringHash)(`${raw.name}:${raw.line}:${raw.column}`, id);
            } while (scopeIds.has(id));
            scopeIds.add(id);
            return new debug_console_items_1.DebugScope(raw, () => this.session, id);
        });
    }
    // https://github.com/theia-ide/vscode/blob/standalone/0.19.x/src/vs/workbench/contrib/debug/common/debugModel.ts#L324-L335
    async getMostSpecificScopes(range) {
        const scopes = await this.getScopes();
        const nonExpensiveScopes = scopes.filter(s => !s.expensive);
        const haveRangeInfo = nonExpensiveScopes.some(s => !!s.range);
        if (!haveRangeInfo) {
            return nonExpensiveScopes;
        }
        const scopesContainingRange = nonExpensiveScopes.filter(scope => scope.range && monaco.Range.containsRange(scope.range, range))
            .sort((first, second) => (first.range.endLineNumber - first.range.startLineNumber) - (second.range.endLineNumber - second.range.startLineNumber));
        return scopesContainingRange.length ? scopesContainingRange : nonExpensiveScopes;
    }
    toArgs(arg) {
        return Object.assign({}, arg, {
            frameId: this.raw.id
        });
    }
    render() {
        const classNames = ['theia-debug-stack-frame'];
        if (this.raw.presentationHint === 'label') {
            classNames.push('label');
        }
        if (this.raw.presentationHint === 'subtle') {
            classNames.push('subtle');
        }
        if (!this.source || this.source.raw.presentationHint === 'deemphasize') {
            classNames.push(browser_1.DISABLED_CLASS);
        }
        return (0, jsx_runtime_1.jsxs)("div", { className: classNames.join(' '), children: [(0, jsx_runtime_1.jsx)("span", { className: 'expression', title: this.raw.name, children: this.raw.name }), this.renderFile()] });
    }
    renderFile() {
        const { source } = this;
        if (!source) {
            return undefined;
        }
        const origin = source.raw.origin && `\n${source.raw.origin}` || '';
        return (0, jsx_runtime_1.jsxs)("span", { className: 'file', title: source.longName + origin, children: [(0, jsx_runtime_1.jsx)("span", { className: 'name', children: source.name }), (0, jsx_runtime_1.jsxs)("span", { className: 'line', children: [this.raw.line, ":", this.raw.column] })] });
    }
    get range() {
        const { source, line: startLine, column: startColumn, endLine, endColumn } = this.raw;
        if (source) {
            return new monaco.Range(startLine, startColumn, endLine || startLine, endColumn || startColumn);
        }
        return undefined;
    }
}
exports.DebugStackFrame = DebugStackFrame;
//# sourceMappingURL=debug-stack-frame.js.map