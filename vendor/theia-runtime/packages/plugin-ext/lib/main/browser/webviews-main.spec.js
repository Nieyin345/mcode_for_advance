"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource GmbH and others.
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
const frontend_application_config_provider_1 = require("@theia/core/lib/browser/frontend-application-config-provider");
const jsdom_1 = require("@theia/core/lib/browser/test/jsdom");
// `webviews-main` transitively pulls in Lumino and several frontend modules that touch
// `document` and the frontend application config at module-load time.
const disableJSDOM = (0, jsdom_1.enableJSDOM)();
try {
    frontend_application_config_provider_1.FrontendApplicationConfigProvider.set({});
}
catch { /* already set by a sibling spec */ }
// xterm.js (pulled in transitively via the terminal package) calls HTMLCanvasElement.prototype.getContext
// at module-load time. JSDOM's default impl throws 'Not implemented' without the optional `canvas`
// package; replace it with a no-op so the module graph evaluates. The tests below never render a terminal.
const canvasProto = globalThis.HTMLCanvasElement?.prototype;
if (canvasProto) {
    canvasProto.getContext = () => undefined;
}
const chai_1 = require("chai");
const webviews_main_1 = require("./webviews-main");
const webview_1 = require("./webview/webview");
after(() => disableJSDOM());
function createWebviewWidget() {
    const widget = { isDisposed: false, title: { label: '' }, messages: [] };
    return Object.assign(widget, {
        setHTML: (value) => { widget.html = value; },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setContentOptions: (options) => { widget.contentOptions = options; },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setIconUrl: (iconUrl) => { widget.iconUrl = iconUrl; },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sendMessage: (value) => { widget.messages.push(value); }
    });
}
/**
 * Bypasses the constructor's RPC/container wiring. The methods under test only resolve
 * the webview widget through the widget manager, so stubbing that is enough.
 */
function createWebviewsMain(widgets) {
    const impl = Object.create(webviews_main_1.WebviewsMainImpl.prototype);
    impl.widgetManager = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        findWidget: async (factoryId, predicate) => {
            if (factoryId !== webview_1.WebviewWidget.FACTORY_ID) {
                return undefined;
            }
            for (const [id, widget] of widgets) {
                if (predicate({ id })) {
                    return widget;
                }
            }
            return undefined;
        },
        getWidget: async () => undefined
    };
    return impl;
}
describe('WebviewsMainImpl - late calls for a disposed webview', () => {
    const handle = 'webview-handle';
    let widgets;
    let webviewsMain;
    beforeEach(() => {
        widgets = new Map();
        webviewsMain = createWebviewsMain(widgets);
    });
    // The plugin host declares these methods as returning `void` and never attaches a rejection
    // handler, so throwing on an unknown handle would surface as an unhandled promise rejection.
    describe('with an unknown handle', () => {
        it('should not reject in $setHtml', async () => {
            await webviewsMain.$setHtml(handle, '<html></html>');
        });
        it('should not reject in $setOptions', async () => {
            await webviewsMain.$setOptions(handle, { enableScripts: true });
        });
        it('should not reject in $setTitle', async () => {
            await webviewsMain.$setTitle(handle, 'Title');
        });
        it('should not reject in $setIconPath', async () => {
            await webviewsMain.$setIconPath(handle, undefined);
        });
        it('should not reject in $reveal', async () => {
            await webviewsMain.$reveal(handle, {});
        });
        it('should resolve to false in $postMessage', async () => {
            (0, chai_1.expect)(await webviewsMain.$postMessage(handle, 'message')).to.be.false;
        });
    });
    describe('with a known handle', () => {
        let widget;
        beforeEach(() => {
            widget = createWebviewWidget();
            widgets.set(handle, widget);
        });
        it('should apply the html in $setHtml', async () => {
            await webviewsMain.$setHtml(handle, '<html></html>');
            (0, chai_1.expect)(widget.html).to.equal('<html></html>');
        });
        it('should apply the content options in $setOptions', async () => {
            await webviewsMain.$setOptions(handle, { enableScripts: true, enableForms: false, enableCommandUris: ['a.command'] });
            (0, chai_1.expect)(widget.contentOptions).to.deep.equal({
                allowScripts: true,
                allowForms: false,
                localResourceRoots: undefined,
                enableCommandUris: ['a.command']
            });
        });
        it('should apply the title in $setTitle', async () => {
            await webviewsMain.$setTitle(handle, 'Title');
            (0, chai_1.expect)(widget.title.label).to.equal('Title');
        });
        it('should send the message in $postMessage', async () => {
            (0, chai_1.expect)(await webviewsMain.$postMessage(handle, 'message')).to.be.true;
            (0, chai_1.expect)(widget.messages).to.deep.equal(['message']);
        });
    });
});
//# sourceMappingURL=webviews-main.spec.js.map