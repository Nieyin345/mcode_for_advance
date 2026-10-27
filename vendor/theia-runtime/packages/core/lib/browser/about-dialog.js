"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AboutDialog = exports.AboutDialogProps = exports.ABOUT_EXTENSIONS_CLASS = exports.ABOUT_CONTENT_CLASS = void 0;
const tslib_1 = require("tslib");
const jsx_runtime_1 = require("react/jsx-runtime");
const inversify_1 = require("inversify");
const dialogs_1 = require("./dialogs");
const react_dialog_1 = require("./dialogs/react-dialog");
const application_protocol_1 = require("../common/application-protocol");
const frontend_application_config_provider_1 = require("./frontend-application-config-provider");
const api_1 = require("@theia/application-package/lib/api");
const window_service_1 = require("./window/window-service");
const keys_1 = require("./keys");
const nls_1 = require("../common/nls");
exports.ABOUT_CONTENT_CLASS = 'theia-aboutDialog';
exports.ABOUT_EXTENSIONS_CLASS = 'theia-aboutExtensions';
let AboutDialogProps = class AboutDialogProps extends dialogs_1.DialogProps {
};
exports.AboutDialogProps = AboutDialogProps;
exports.AboutDialogProps = AboutDialogProps = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], AboutDialogProps);
let AboutDialog = class AboutDialog extends react_dialog_1.ReactDialog {
    constructor(props) {
        super({
            title: frontend_application_config_provider_1.FrontendApplicationConfigProvider.get().applicationName,
        });
        this.props = props;
        this.extensionsInfos = [];
        /**
         * Open a link in an external window.
         * @param url the link.
         */
        this.doOpenExternalLink = (url) => this.windowService.openNewWindow(url, { external: true });
        this.doOpenExternalLinkEnter = (e, url) => {
            if (this.isEnterKey(e)) {
                this.doOpenExternalLink(url);
            }
        };
        this.appendAcceptButton(dialogs_1.Dialog.OK);
    }
    init() {
        this.doInit();
    }
    async doInit() {
        this.applicationInfo = await this.appServer.getApplicationInfo();
        this.extensionsInfos = await this.appServer.getExtensionsInfos();
        this.update();
    }
    renderHeader() {
        const applicationInfo = this.applicationInfo;
        const compatibilityUrl = 'https://eclipse-theia.github.io/vscode-theia-comparator/status.html';
        const detailsLabel = nls_1.nls.localizeByDefault('Details');
        const versionLabel = nls_1.nls.localizeByDefault('Version');
        const defaultApiLabel = nls_1.nls.localize('theia/core/about/defaultApi', 'Default {0} API', 'VS Code');
        const compatibilityLabel = nls_1.nls.localize('theia/core/about/compatibility', '{0} Compatibility', 'VS Code');
        const monacoLabel = nls_1.nls.localize('theia/core/about/monacoEditor', 'Monaco Editor Version');
        return (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("h3", { children: detailsLabel }), (0, jsx_runtime_1.jsxs)("div", { className: 'about-details', children: [applicationInfo && (0, jsx_runtime_1.jsx)("p", { children: `${versionLabel}: ${applicationInfo.version}` }), (0, jsx_runtime_1.jsx)("p", { children: `${defaultApiLabel}: ${api_1.DEFAULT_SUPPORTED_API_VERSION}` }), (0, jsx_runtime_1.jsx)("p", { children: (0, jsx_runtime_1.jsx)("a", { role: 'button', tabIndex: 0, onClick: () => this.doOpenExternalLink(compatibilityUrl), onKeyDown: (e) => this.doOpenExternalLinkEnter(e, compatibilityUrl), children: compatibilityLabel }) }), (0, jsx_runtime_1.jsx)("p", { children: `${monacoLabel}: ${api_1.DEFAULT_SUPPORTED_MONACO_VERSION}` })] })] });
    }
    renderExtensions() {
        const extensionsInfos = this.extensionsInfos;
        const listOfExtensions = nls_1.nls.localize('theia/core/about/listOfExtensions', 'List of extensions');
        return (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("h3", { children: listOfExtensions }), (0, jsx_runtime_1.jsx)("ul", { className: exports.ABOUT_EXTENSIONS_CLASS, children: extensionsInfos
                        .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
                        .map((extension) => (0, jsx_runtime_1.jsxs)("li", { children: [extension.name, " ", extension.version] }, extension.name)) })] });
    }
    render() {
        return (0, jsx_runtime_1.jsxs)("div", { className: exports.ABOUT_CONTENT_CLASS, children: [this.renderHeader(), this.renderExtensions()] });
    }
    onAfterAttach(msg) {
        super.onAfterAttach(msg);
        this.update();
    }
    isEnterKey(e) {
        return keys_1.Key.ENTER.keyCode === keys_1.KeyCode.createKeyCode(e.nativeEvent).key?.keyCode;
    }
    get value() { return undefined; }
};
exports.AboutDialog = AboutDialog;
tslib_1.__decorate([
    (0, inversify_1.inject)(application_protocol_1.ApplicationServer),
    tslib_1.__metadata("design:type", Object)
], AboutDialog.prototype, "appServer", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(window_service_1.WindowService),
    tslib_1.__metadata("design:type", Object)
], AboutDialog.prototype, "windowService", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], AboutDialog.prototype, "init", null);
exports.AboutDialog = AboutDialog = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__param(0, (0, inversify_1.inject)(AboutDialogProps)),
    tslib_1.__metadata("design:paramtypes", [AboutDialogProps])
], AboutDialog);
//# sourceMappingURL=about-dialog.js.map