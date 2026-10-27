"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReactDialog = void 0;
const tslib_1 = require("tslib");
const jsx_runtime_1 = require("react/jsx-runtime");
const inversify_1 = require("inversify");
const common_1 = require("../../common");
const dialogs_1 = require("../dialogs");
const client_1 = require("react-dom/client");
let ReactDialog = class ReactDialog extends dialogs_1.AbstractDialog {
    constructor(props) {
        super(props);
        this.contentNodeRoot = (0, client_1.createRoot)(this.contentNode);
        this.isMounted = true;
        this.toDispose.push(common_1.Disposable.create(() => {
            this.contentNodeRoot.unmount();
            this.isMounted = false;
        }));
    }
    onUpdateRequest(msg) {
        super.onUpdateRequest(msg);
        if (!this.isMounted) {
            this.contentNodeRoot = (0, client_1.createRoot)(this.contentNode);
            this.isMounted = true;
        }
        this.contentNodeRoot?.render((0, jsx_runtime_1.jsx)(jsx_runtime_1.Fragment, { children: this.render() }));
    }
};
exports.ReactDialog = ReactDialog;
exports.ReactDialog = ReactDialog = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__param(0, (0, inversify_1.inject)(dialogs_1.DialogProps)),
    tslib_1.__metadata("design:paramtypes", [dialogs_1.DialogProps])
], ReactDialog);
//# sourceMappingURL=react-dialog.js.map