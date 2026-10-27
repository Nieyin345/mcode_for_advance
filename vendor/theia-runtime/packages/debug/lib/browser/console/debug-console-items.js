"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DebugScope = exports.ExpressionItem = exports.DebugVirtualVariable = exports.DebugVariable = exports.ExpressionContainer = void 0;
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
const browser_1 = require("@theia/core/lib/browser");
const console_session_1 = require("@theia/console/lib/browser/console-session");
const debug_session_1 = require("../debug-session");
const severity_1 = require("@theia/core/lib/common/severity");
const monaco = require("@theia/monaco-editor-core");
const core_1 = require("@theia/core");
class ExpressionContainer {
    static { this.BASE_CHUNK_SIZE = 100; }
    get session() {
        return this.sessionProvider();
    }
    constructor(options) {
        this.sessionProvider = options.session;
        this.id = options.id ?? (0, core_1.generateUuid)();
        this.variablesReference = options.variablesReference || 0;
        this.namedVariables = options.namedVariables;
        this.indexedVariables = options.indexedVariables;
        this.startOfVariables = options.startOfVariables || 0;
        this.presentationHint = options.presentationHint;
        if (this.lazy) {
            this.expandByDefault = () => !this.lazy && !this.session?.autoExpandLazyVariables;
        }
    }
    render() {
        return undefined;
    }
    get reference() {
        return this.variablesReference;
    }
    get hasElements() {
        return !!this.variablesReference && !this.lazy;
    }
    get lazy() {
        return !!this.presentationHint?.lazy;
    }
    async resolveLazy() {
        const { session, variablesReference, lazy } = this;
        if (!session || !variablesReference || !lazy) {
            return;
        }
        const response = await session.sendRequest('variables', { variablesReference });
        const { variables } = response.body;
        if (variables.length !== 1) {
            return;
        }
        this.handleResolvedLazy(variables[0]);
    }
    handleResolvedLazy(resolved) {
        this.variablesReference = resolved.variablesReference;
        this.namedVariables = resolved.namedVariables;
        this.indexedVariables = resolved.indexedVariables;
        this.presentationHint = resolved.presentationHint;
    }
    async getElements() {
        if (!this.hasElements || !this.session) {
            return [][Symbol.iterator]();
        }
        if (!this.elements) {
            this.elements = this.doResolve();
        }
        return (await this.elements)[Symbol.iterator]();
    }
    async doResolve() {
        const result = [];
        if (this.namedVariables) {
            await this.fetch(result, 'named');
        }
        if (this.indexedVariables) {
            let chunkSize = ExpressionContainer.BASE_CHUNK_SIZE;
            while (this.indexedVariables > chunkSize * ExpressionContainer.BASE_CHUNK_SIZE) {
                chunkSize *= ExpressionContainer.BASE_CHUNK_SIZE;
            }
            if (this.indexedVariables > chunkSize) {
                const numberOfChunks = Math.ceil(this.indexedVariables / chunkSize);
                for (let i = 0; i < numberOfChunks; i++) {
                    const start = this.startOfVariables + i * chunkSize;
                    const count = Math.min(chunkSize, this.indexedVariables - i * chunkSize);
                    const { variablesReference } = this;
                    const name = `[${start}..${start + count - 1}]`;
                    result.push(new DebugVirtualVariable({
                        session: this.sessionProvider,
                        id: `${this.id}:${name}`,
                        variablesReference,
                        namedVariables: 0,
                        indexedVariables: count,
                        startOfVariables: start,
                        name
                    }));
                }
                return result;
            }
        }
        await this.fetch(result, 'indexed', this.startOfVariables, this.indexedVariables);
        return result;
    }
    async fetch(result, filter, start, count) {
        try {
            const { session } = this;
            if (session) {
                const { variablesReference } = this;
                const response = await session.sendRequest('variables', { variablesReference, filter, start, count });
                const { variables } = response.body;
                const names = new Set();
                const debugVariables = [];
                for (const variable of variables) {
                    if (!names.has(variable.name)) {
                        const v = new DebugVariable(this.sessionProvider, variable, this);
                        debugVariables.push(v);
                        result.push(v);
                        names.add(variable.name);
                    }
                }
                if (session.autoExpandLazyVariables) {
                    await Promise.all(debugVariables.map(v => v.lazy && v.resolveLazy()));
                }
            }
        }
        catch (e) {
            result.push({
                severity: severity_1.Severity.Error,
                visible: !!e.message,
                render: () => e.message
            });
        }
    }
}
exports.ExpressionContainer = ExpressionContainer;
class DebugVariable extends ExpressionContainer {
    static { this.booleanRegex = /^true|false$/i; }
    static { this.stringRegex = /^(['"]).*\1$/; }
    constructor(session, variable, parent) {
        super({
            session,
            id: `${parent.id}:${variable.name}`,
            variablesReference: variable.variablesReference,
            namedVariables: variable.namedVariables,
            indexedVariables: variable.indexedVariables,
            presentationHint: variable.presentationHint
        });
        this.variable = variable;
        this.parent = parent;
        this.handleLazyButtonClick = () => this.resolveLazy();
        this.setValueRef = (valueRef) => { this.valueRef = valueRef || undefined; };
        this.setNameRef = (nameRef) => { this.nameRef = nameRef || undefined; };
    }
    get name() {
        return this.variable.name;
    }
    get evaluateName() {
        return this.variable.evaluateName;
    }
    get type() {
        return this._type || this.variable.type;
    }
    get value() {
        return this._value || this.variable.value;
    }
    get readOnly() {
        return this.presentationHint?.attributes?.includes('readOnly') || this.lazy;
    }
    render() {
        const { type, value, name, lazy } = this;
        return (0, jsx_runtime_1.jsxs)("div", { className: this.variableClassName, children: [(0, jsx_runtime_1.jsxs)("span", { title: type || name, className: 'name', ref: this.setNameRef, children: [name, (value || lazy) && ': '] }), lazy && (0, jsx_runtime_1.jsx)("span", { title: core_1.nls.localizeByDefault('Click to expand'), className: (0, browser_1.codicon)('eye') + ' lazy-button', onClick: this.handleLazyButtonClick }), (0, jsx_runtime_1.jsx)("span", { title: value, className: 'value', ref: this.setValueRef, children: value })] });
    }
    get variableClassName() {
        const { type, value } = this;
        const classNames = ['theia-debug-console-variable'];
        if (type === 'number' || type === 'boolean' || type === 'string') {
            classNames.push(type);
        }
        else if (!isNaN(+value)) {
            classNames.push('number');
        }
        else if (DebugVariable.booleanRegex.test(value)) {
            classNames.push('boolean');
        }
        else if (DebugVariable.stringRegex.test(value)) {
            classNames.push('string');
        }
        return classNames.join(' ');
    }
    handleResolvedLazy(resolved) {
        this._value = resolved.value;
        this._type = resolved.type || this._type;
        super.handleResolvedLazy(resolved);
        this.session?.['onDidResolveLazyVariableEmitter'].fire(this);
    }
    get supportSetVariable() {
        return !!this.session && !!this.session.capabilities.supportsSetVariable;
    }
    async setValue(value) {
        if (!this.session || value === this.value) {
            return;
        }
        const { name, parent } = this;
        const variablesReference = parent['variablesReference'];
        const response = await this.session.sendRequest('setVariable', { variablesReference, name, value });
        this._value = response.body.value;
        this._type = response.body.type;
        this.variablesReference = response.body.variablesReference || 0;
        this.namedVariables = response.body.namedVariables;
        this.indexedVariables = response.body.indexedVariables;
        this.elements = undefined;
        this.session['fireDidChange']();
    }
    get supportCopyValue() {
        return !!this.valueRef && document.queryCommandSupported('copy');
    }
    copyValue() {
        const selection = document.getSelection();
        if (this.valueRef && selection) {
            selection.selectAllChildren(this.valueRef);
            document.execCommand('copy');
        }
    }
    get supportCopyAsExpression() {
        return !!this.nameRef && document.queryCommandSupported('copy');
    }
    copyAsExpression() {
        const selection = document.getSelection();
        if (this.nameRef && selection) {
            selection.selectAllChildren(this.nameRef);
            document.execCommand('copy');
        }
    }
    async open() {
        if (!this.supportSetVariable || this.readOnly) {
            return;
        }
        const input = new browser_1.SingleTextInputDialog({
            title: core_1.nls.localize('theia/debug/debugVariableInput', 'Set {0} Value', this.name),
            initialValue: this.value,
            placeholder: core_1.nls.localizeByDefault('Value'),
            validate: async (value, mode) => {
                if (!value) {
                    return false;
                }
                if (mode === 'open') {
                    try {
                        await this.setValue(value);
                    }
                    catch (error) {
                        console.error('setValue failed:', error);
                        if (error.body?.error) {
                            const errorMessage = error.body.error;
                            if (errorMessage.showUser) {
                                return (0, debug_session_1.formatMessage)(errorMessage.format, errorMessage.variables);
                            }
                        }
                    }
                }
                return true;
            }
        });
        await input.open();
    }
}
exports.DebugVariable = DebugVariable;
class DebugVirtualVariable extends ExpressionContainer {
    constructor(options) {
        super(options);
        this.options = options;
    }
    render() {
        return this.options.name;
    }
}
exports.DebugVirtualVariable = DebugVirtualVariable;
class ExpressionItem extends ExpressionContainer {
    static { this.notAvailable = core_1.nls.localizeByDefault('not available'); }
    get value() {
        return this._value;
    }
    get type() {
        return this._type;
    }
    get available() {
        return this._available;
    }
    constructor(_expression, session, id) {
        super({ session, id });
        this._expression = _expression;
        this._value = ExpressionItem.notAvailable;
        this._available = false;
    }
    get expression() {
        return this._expression;
    }
    render() {
        const valueClassNames = [];
        if (!this._available) {
            valueClassNames.push(console_session_1.ConsoleItem.errorClassName);
            valueClassNames.push('theia-debug-console-unavailable');
        }
        return (0, jsx_runtime_1.jsxs)("div", { className: 'theia-debug-console-expression', children: [(0, jsx_runtime_1.jsx)("div", { children: this._expression }), (0, jsx_runtime_1.jsx)("div", { className: valueClassNames.join(' '), children: this._value })] });
    }
    async evaluate(context = 'repl', resolveLazy = true) {
        const session = this.session;
        if (!session?.currentFrame) {
            this.setResult(undefined, ExpressionItem.notAvailable);
            return;
        }
        try {
            const body = await session.evaluate(this._expression, context);
            this.setResult(body);
            if (this.lazy && resolveLazy) {
                await this.resolveLazy();
            }
        }
        catch (err) {
            this.setResult(undefined, err.message);
        }
    }
    setResult(body, error = ExpressionItem.notAvailable) {
        if (body) {
            this._value = body.result;
            this._type = body.type;
            this._available = true;
            this.variablesReference = body.variablesReference;
            this.namedVariables = body.namedVariables;
            this.indexedVariables = body.indexedVariables;
            this.presentationHint = body.presentationHint;
            this.severity = severity_1.Severity.Log;
        }
        else {
            this._value = error;
            this._type = undefined;
            this._available = false;
            this.variablesReference = 0;
            this.namedVariables = undefined;
            this.indexedVariables = undefined;
            this.presentationHint = undefined;
            this.severity = severity_1.Severity.Error;
        }
        this.elements = undefined;
    }
    handleResolvedLazy(resolved) {
        this._value = resolved.value;
        this._type = resolved.type || this._type;
        super.handleResolvedLazy(resolved);
    }
}
exports.ExpressionItem = ExpressionItem;
class DebugScope extends ExpressionContainer {
    constructor(raw, session, id) {
        super({
            session,
            id: `${raw.name}:${id}`,
            variablesReference: raw.variablesReference,
            namedVariables: raw.namedVariables,
            indexedVariables: raw.indexedVariables
        });
        this.raw = raw;
    }
    render() {
        return this.name;
    }
    get expensive() {
        return this.raw.expensive;
    }
    get range() {
        const { line, column, endLine, endColumn } = this.raw;
        if (line !== undefined && column !== undefined && endLine !== undefined && endColumn !== undefined) {
            return new monaco.Range(line, column, endLine, endColumn);
        }
        return undefined;
    }
    get name() {
        return this.raw.name;
    }
    expandByDefault() {
        return this.raw.presentationHint === 'locals';
    }
}
exports.DebugScope = DebugScope;
//# sourceMappingURL=debug-console-items.js.map