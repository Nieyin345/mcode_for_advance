"use strict";
// *****************************************************************************
// Copyright (C) 2022 Ericsson and others.
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
exports.MonacoMarkdownRenderer = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const markdownRenderer_1 = require("@theia/monaco-editor-core/esm/vs/platform/markdown/browser/markdownRenderer");
const standaloneServices_1 = require("@theia/monaco-editor-core/esm/vs/editor/standalone/browser/standaloneServices");
const browser_1 = require("@theia/core/lib/browser");
const opener_1 = require("@theia/monaco-editor-core/esm/vs/platform/opener/common/opener");
const uri_1 = require("@theia/core/lib/common/uri");
const markdown_link_handler_1 = require("@theia/core/lib/browser/markdown-rendering/markdown-link-handler");
const lifecycle_1 = require("@theia/monaco-editor-core/esm/vs/base/common/lifecycle");
const core_1 = require("@theia/core");
let MonacoMarkdownRenderer = class MonacoMarkdownRenderer {
    render(markdown, options) {
        const rendered = this.delegate.render(markdown, this.transformOptions(options));
        // The delegate activates links through its own opener service, which `interceptOpen`
        // routes to Theia's. Declaring that keeps callers from wiring a second handler, which
        // would open every link twice.
        (0, markdown_link_handler_1.markMarkdownLinksWired)(rendered.element);
        return rendered;
    }
    transformOptions(options) {
        if (!options) {
            return undefined;
        }
        const { actionHandler, ...opts } = options;
        if (!actionHandler) {
            return opts;
        }
        return {
            ...opts,
            actionHandler: (content) => actionHandler.callback(content)
        };
    }
    toDisposableStore(current) {
        if (current instanceof lifecycle_1.DisposableStore) {
            return current;
        }
        else if (current instanceof core_1.DisposableCollection) {
            const store = new lifecycle_1.DisposableStore();
            current['disposables'].forEach(disposable => store.add(disposable));
            return store;
        }
        else {
            return new lifecycle_1.DisposableStore();
        }
    }
    init() {
        const openerService = standaloneServices_1.StandaloneServices.get(opener_1.IOpenerService);
        openerService.registerOpener({
            open: (u, options) => this.interceptOpen(u, options)
        });
        this.delegate = new markdownRenderer_1.MarkdownRendererService(openerService);
    }
    async interceptOpen(monacoUri, monacoOptions) {
        let options = undefined;
        if (monacoOptions) {
            if ('openToSide' in monacoOptions && monacoOptions.openToSide) {
                options = Object.assign(options || {}, {
                    widgetOptions: {
                        mode: 'split-right'
                    }
                });
            }
            if ('openExternal' in monacoOptions && monacoOptions.openExternal) {
                options = Object.assign(options || {}, {
                    openExternal: true
                });
            }
        }
        const uri = new uri_1.URI(monacoUri.toString());
        try {
            await (0, browser_1.open)(this.openerService, uri, options);
            return true;
        }
        catch (e) {
            this.logger.error(`Fail to open '${uri.toString()}':`, e);
            return false;
        }
    }
};
exports.MonacoMarkdownRenderer = MonacoMarkdownRenderer;
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.OpenerService),
    tslib_1.__metadata("design:type", Object)
], MonacoMarkdownRenderer.prototype, "openerService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('monaco:MonacoMarkdownRenderer'),
    tslib_1.__metadata("design:type", Object)
], MonacoMarkdownRenderer.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], MonacoMarkdownRenderer.prototype, "init", null);
exports.MonacoMarkdownRenderer = MonacoMarkdownRenderer = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MonacoMarkdownRenderer);
//# sourceMappingURL=monaco-markdown-renderer.js.map