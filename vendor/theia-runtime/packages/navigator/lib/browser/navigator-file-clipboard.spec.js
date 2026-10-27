"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource and others.
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
const jsdom_1 = require("@theia/core/lib/browser/test/jsdom");
const disableJSDOM = (0, jsdom_1.enableJSDOM)();
const frontend_application_config_provider_1 = require("@theia/core/lib/browser/frontend-application-config-provider");
frontend_application_config_provider_1.FrontendApplicationConfigProvider.set({});
const chai_1 = require("chai");
const inversify_1 = require("@theia/core/shared/inversify");
const event_1 = require("@theia/core/lib/common/event");
const clipboard_service_1 = require("@theia/core/lib/browser/clipboard-service");
const navigator_file_clipboard_1 = require("./navigator-file-clipboard");
disableJSDOM();
describe('NavigatorFileClipboard', () => {
    let jsdomCleanup;
    let clipboard;
    let onDidWriteTextEmitter;
    before(() => {
        jsdomCleanup = (0, jsdom_1.enableJSDOM)();
    });
    after(() => {
        jsdomCleanup();
    });
    function createClipboard(clipboardService) {
        const container = new inversify_1.Container();
        container.bind(clipboard_service_1.ClipboardService).toConstantValue(clipboardService);
        container.bind(navigator_file_clipboard_1.NavigatorFileClipboard).toSelf().inSingletonScope();
        return container.get(navigator_file_clipboard_1.NavigatorFileClipboard);
    }
    beforeEach(() => {
        onDidWriteTextEmitter = new event_1.Emitter();
        clipboard = createClipboard({
            readText: async () => '',
            writeText: async () => undefined,
            onDidWriteText: onDidWriteTextEmitter.event
        });
    });
    it('should return undefined when nothing was copied', () => {
        (0, chai_1.expect)(clipboard.get()).to.be.undefined;
    });
    it('should return the copied text', () => {
        clipboard.set('file:///workspace/a.txt');
        (0, chai_1.expect)(clipboard.get()).to.equal('file:///workspace/a.txt');
    });
    it('should treat empty text as unset', () => {
        clipboard.set('');
        (0, chai_1.expect)(clipboard.get()).to.be.undefined;
    });
    it('should keep the content when set during a copy event', () => {
        // simulates the navigator updating the clipboard within its own copy listener
        const listener = () => clipboard.set('file:///workspace/a.txt');
        document.addEventListener('copy', listener);
        try {
            document.body.dispatchEvent(new window.Event('copy', { bubbles: true }));
        }
        finally {
            document.removeEventListener('copy', listener);
        }
        (0, chai_1.expect)(clipboard.get()).to.equal('file:///workspace/a.txt');
    });
    it('should clear the content when something else is copied', () => {
        clipboard.set('file:///workspace/a.txt');
        document.body.dispatchEvent(new window.Event('copy', { bubbles: true }));
        (0, chai_1.expect)(clipboard.get()).to.be.undefined;
    });
    it('should clear the content when something else is cut', () => {
        clipboard.set('file:///workspace/a.txt');
        document.body.dispatchEvent(new window.Event('cut', { bubbles: true }));
        (0, chai_1.expect)(clipboard.get()).to.be.undefined;
    });
    it('should clear the content when text is written through the clipboard service', () => {
        // e.g. Copy Path writes via ClipboardService.writeText, which dispatches no DOM copy event
        clipboard.set('file:///workspace/a.txt');
        onDidWriteTextEmitter.fire('/workspace/b.txt');
        (0, chai_1.expect)(clipboard.get()).to.be.undefined;
    });
    it('should work with a clipboard service lacking the optional write event', () => {
        clipboard = createClipboard({
            readText: async () => '',
            writeText: async () => undefined
        });
        clipboard.set('file:///workspace/a.txt');
        (0, chai_1.expect)(clipboard.get()).to.equal('file:///workspace/a.txt');
    });
});
//# sourceMappingURL=navigator-file-clipboard.spec.js.map