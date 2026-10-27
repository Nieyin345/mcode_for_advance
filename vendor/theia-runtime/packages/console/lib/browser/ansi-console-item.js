"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AnsiConsoleItem = void 0;
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
const DOMPurify = require("@theia/core/shared/dompurify");
const Anser = require("anser");
class AnsiConsoleItem {
    constructor(content, severity) {
        this.content = content;
        this.severity = severity;
        this.htmlContent = new Anser().ansiToHtml(this.content, {
            use_classes: true,
            remove_empty: true
        });
    }
    get visible() {
        return !!this.htmlContent;
    }
    render() {
        return (0, jsx_runtime_1.jsx)("div", { className: 'theia-console-ansi-console-item', dangerouslySetInnerHTML: { __html: DOMPurify.sanitize(this.htmlContent) } });
    }
}
exports.AnsiConsoleItem = AnsiConsoleItem;
//# sourceMappingURL=ansi-console-item.js.map