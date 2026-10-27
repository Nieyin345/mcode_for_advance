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
const navigator_contribution_1 = require("./navigator-contribution");
disableJSDOM();
describe('FileNavigatorContribution', () => {
    let contribution;
    let navigatorWidget;
    let currentWidget;
    let clipboardText;
    let fileClipboardText;
    let systemClipboardReads;
    let pastedTexts;
    let pasteError;
    let errorMessages;
    let selectedNodes;
    function createNavigatorWidgetStub() {
        return {
            canPasteFiles: (raw) => raw !== '' && selectedNodes.length > 0,
            pasteFiles: (raw) => {
                pastedTexts.push(raw);
                return pasteError ? Promise.reject(pasteError) : Promise.resolve(true);
            }
        };
    }
    beforeEach(() => {
        clipboardText = '';
        fileClipboardText = undefined;
        systemClipboardReads = 0;
        pastedTexts = [];
        pasteError = undefined;
        errorMessages = [];
        selectedNodes = [];
        navigatorWidget = createNavigatorWidgetStub();
        currentWidget = navigatorWidget;
        contribution = new navigator_contribution_1.FileNavigatorContribution({}, {}, {}, {}, {});
        Object.assign(contribution, {
            widgetManager: {
                tryGetWidget: () => navigatorWidget
            },
            shell: {
                get currentWidget() {
                    return currentWidget;
                }
            },
            clipboardService: {
                readText: async () => {
                    systemClipboardReads++;
                    return clipboardText;
                }
            },
            fileClipboard: {
                get: () => fileClipboardText
            },
            messageService: {
                error: (message) => {
                    errorMessages.push(message);
                }
            }
        });
    });
    describe('canPasteIntoNavigator', () => {
        it('should be disabled if the navigator widget has not been created', () => {
            navigatorWidget = undefined;
            (0, chai_1.expect)(contribution['canPasteIntoNavigator']()).to.be.false;
        });
        it('should be disabled if the navigator is not the current widget', () => {
            selectedNodes = [{ id: 'target' }];
            currentWidget = undefined;
            (0, chai_1.expect)(contribution['canPasteIntoNavigator']()).to.be.false;
        });
        it('should be disabled if no paste target is selected', () => {
            (0, chai_1.expect)(contribution['canPasteIntoNavigator']()).to.be.false;
        });
        it('should be enabled if the navigator is the current widget and a paste target is selected', () => {
            selectedNodes = [{ id: 'target' }];
            (0, chai_1.expect)(contribution['canPasteIntoNavigator']()).to.be.true;
        });
    });
    describe('pasteIntoNavigator', () => {
        it('should paste the clipboard text into the navigator', async () => {
            clipboardText = 'file:///workspace/a.txt';
            await contribution['pasteIntoNavigator']();
            (0, chai_1.expect)(pastedTexts).to.deep.equal(['file:///workspace/a.txt']);
        });
        it('should not paste anything for empty clipboard text', async () => {
            await contribution['pasteIntoNavigator']();
            (0, chai_1.expect)(pastedTexts).to.have.lengthOf(0);
        });
        it('should prefer the file clipboard over the system clipboard', async () => {
            fileClipboardText = 'file:///workspace/copied-in-app.txt';
            clipboardText = 'file:///workspace/copied-outside.txt';
            await contribution['pasteIntoNavigator']();
            (0, chai_1.expect)(pastedTexts).to.deep.equal(['file:///workspace/copied-in-app.txt']);
            (0, chai_1.expect)(systemClipboardReads).to.equal(0);
        });
        it('should fall back to the system clipboard if the file clipboard is empty', async () => {
            clipboardText = 'file:///workspace/copied-outside.txt';
            await contribution['pasteIntoNavigator']();
            (0, chai_1.expect)(pastedTexts).to.deep.equal(['file:///workspace/copied-outside.txt']);
            (0, chai_1.expect)(systemClipboardReads).to.equal(1);
        });
        it('should report a failed paste instead of rejecting unhandled', async () => {
            clipboardText = 'file:///workspace/a.txt';
            pasteError = new Error('Parent of file has to be a FileStatNode');
            await contribution['pasteIntoNavigator']();
            (0, chai_1.expect)(errorMessages).to.deep.equal(['Parent of file has to be a FileStatNode']);
        });
    });
});
//# sourceMappingURL=navigator-contribution.spec.js.map