"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DebugWatchExpression = void 0;
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
const dialogs_1 = require("@theia/core/lib/browser/dialogs");
const debug_console_items_1 = require("../console/debug-console-items");
const browser_1 = require("@theia/core/lib/browser");
const core_1 = require("@theia/core");
class DebugWatchExpression extends debug_console_items_1.ExpressionItem {
    constructor(options) {
        super(options.expression, options.session, options.id);
        this.options = options;
        this.setValueRef = (valueRef) => { this.valueRef = valueRef || undefined; };
    }
    async evaluate() {
        await super.evaluate('watch');
        this.options.onDidChange();
    }
    setResult(body, error) {
        const session = this.options.session();
        this.isNotAvailable = false;
        this.isError = false;
        // not available must be set regardless of the session's availability.
        // not available is used when there is no session or the current stack frame is not available.
        if (error === debug_console_items_1.ExpressionItem.notAvailable) {
            super.setResult(undefined, error);
            this.isNotAvailable = true;
        }
        else if (session) {
            super.setResult(body, error);
            this.isError = !!error;
        }
    }
    render() {
        const valueClass = this.valueClass();
        return (0, jsx_runtime_1.jsxs)("div", { className: 'theia-debug-console-variable theia-debug-watch-expression', children: [(0, jsx_runtime_1.jsxs)("div", { className: browser_1.TREE_NODE_SEGMENT_GROW_CLASS, children: [(0, jsx_runtime_1.jsxs)("span", { title: this.type || this._expression, className: 'name', children: [this._expression, ":"] }), (0, jsx_runtime_1.jsx)("span", { title: this._value, ref: this.setValueRef, className: valueClass, children: this._value })] }), (0, jsx_runtime_1.jsx)("div", { className: (0, browser_1.codicon)('close', true), title: core_1.nls.localizeByDefault('Remove Expression'), onClick: this.options.remove })] });
    }
    valueClass() {
        if (this.isError) {
            return 'watch-error';
        }
        if (this.isNotAvailable) {
            return 'watch-not-available';
        }
        return 'value';
    }
    async open() {
        const input = new dialogs_1.SingleTextInputDialog({
            title: core_1.nls.localizeByDefault('Edit Expression'),
            initialValue: this.expression,
            placeholder: core_1.nls.localizeByDefault('Expression to watch')
        });
        const newValue = await input.open();
        if (newValue !== undefined) {
            this._expression = newValue;
            await this.evaluate();
        }
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
}
exports.DebugWatchExpression = DebugWatchExpression;
//# sourceMappingURL=debug-watch-expression.js.map