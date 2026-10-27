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
const uri_1 = require("@theia/core/lib/common/uri");
const navigator_widget_1 = require("./navigator-widget");
disableJSDOM();
describe('FileNavigatorWidget', () => {
    const workspaceRoot = new uri_1.default('file:///workspace');
    let copiedSources;
    let selectedNodes;
    let storedClipboardContents;
    let infoMessages;
    let errorMessages;
    let widget;
    const targetNode = { id: 'target', uri: workspaceRoot };
    function createWidget(root = workspaceRoot) {
        copiedSources = [];
        selectedNodes = [];
        storedClipboardContents = [];
        infoMessages = [];
        errorMessages = [];
        const model = {
            get selectedFileStatNodes() {
                return selectedNodes;
            },
            copy: (source, target) => {
                (0, chai_1.expect)(target).to.equal(targetNode);
                copiedSources.push(source);
                return Promise.resolve(source);
            }
        };
        const navigator = new navigator_widget_1.FileNavigatorWidget({}, model, {});
        const workspaceService = {
            getWorkspaceRootUri: (uri) => uri && root.isEqualOrParent(uri) ? root : undefined
        };
        const fileClipboard = {
            set: (content) => {
                storedClipboardContents.push(content);
            }
        };
        const messageService = {
            info: (message) => {
                infoMessages.push(message);
            },
            error: (message) => {
                errorMessages.push(message);
            }
        };
        Object.assign(navigator, { workspaceService, fileClipboard, messageService });
        return navigator;
    }
    let jsdomCleanup;
    before(() => {
        jsdomCleanup = (0, jsdom_1.enableJSDOM)();
    });
    after(() => {
        jsdomCleanup();
    });
    beforeEach(() => {
        widget = createWidget();
    });
    describe('pasteFiles', () => {
        it('should not paste anything for empty clipboard text', async () => {
            selectedNodes = [targetNode];
            (0, chai_1.expect)(await widget.pasteFiles('')).to.be.false;
            (0, chai_1.expect)(copiedSources).to.have.lengthOf(0);
        });
        it('should not paste anything if no target node is selected', async () => {
            (0, chai_1.expect)(await widget.pasteFiles('file:///workspace/some-file.txt')).to.be.false;
            (0, chai_1.expect)(copiedSources).to.have.lengthOf(0);
        });
        it('should copy valid workspace URIs to the selected target', async () => {
            selectedNodes = [targetNode];
            (0, chai_1.expect)(await widget.pasteFiles('file:///workspace/a.txt\nfile:///workspace/dir/b.txt')).to.be.true;
            (0, chai_1.expect)(copiedSources.map(uri => uri.toString())).to.deep.equal([
                'file:///workspace/a.txt',
                'file:///workspace/dir/b.txt'
            ]);
        });
        it('should resolve only after the copies completed', async () => {
            selectedNodes = [targetNode];
            let completedCopies = 0;
            widget.model.copy = async (source) => {
                await new Promise(resolve => setTimeout(resolve, 5));
                completedCopies++;
                return source;
            };
            (0, chai_1.expect)(await widget.pasteFiles('file:///workspace/a.txt\nfile:///workspace/b.txt')).to.be.true;
            (0, chai_1.expect)(completedCopies).to.equal(2);
        });
        it('should skip blank lines, invalid URIs and URIs outside the workspace', async () => {
            selectedNodes = [targetNode];
            const raw = [
                '',
                '   ',
                'not a uri',
                'file:///outside/c.txt',
                'file:///workspace/d.txt'
            ].join('\n');
            (0, chai_1.expect)(await widget.pasteFiles(raw)).to.be.true;
            (0, chai_1.expect)(copiedSources.map(uri => uri.toString())).to.deep.equal(['file:///workspace/d.txt']);
            (0, chai_1.expect)(infoMessages).to.have.lengthOf(0);
        });
        it('should paste files given as absolute file system paths', async () => {
            selectedNodes = [targetNode];
            (0, chai_1.expect)(await widget.pasteFiles('/workspace/e.txt')).to.be.true;
            (0, chai_1.expect)(copiedSources.map(uri => uri.toString())).to.deep.equal(['file:///workspace/e.txt']);
            (0, chai_1.expect)(infoMessages).to.have.lengthOf(0);
        });
        it('should paste files given as Windows-style absolute paths', async () => {
            widget = createWidget(uri_1.default.fromFilePath('C:\\workspace'));
            selectedNodes = [targetNode];
            (0, chai_1.expect)(await widget.pasteFiles('C:\\workspace\\sub\\f.txt')).to.be.true;
            (0, chai_1.expect)(copiedSources.map(uri => uri.toString())).to.deep.equal([uri_1.default.fromFilePath('C:\\workspace\\sub\\f.txt').toString()]);
            (0, chai_1.expect)(infoMessages).to.have.lengthOf(0);
        });
        it('should not paste relative paths', async () => {
            selectedNodes = [targetNode];
            (0, chai_1.expect)(await widget.pasteFiles('workspace/relative.txt')).to.be.true;
            (0, chai_1.expect)(copiedSources).to.have.lengthOf(0);
        });
        it('should inform the user when the clipboard contains no pastable files', async () => {
            selectedNodes = [targetNode];
            (0, chai_1.expect)(await widget.pasteFiles('not a uri')).to.be.true;
            (0, chai_1.expect)(copiedSources).to.have.lengthOf(0);
            (0, chai_1.expect)(infoMessages).to.have.lengthOf(1);
        });
        it('should stay silent for empty clipboard text or missing paste target', async () => {
            (0, chai_1.expect)(await widget.pasteFiles('file:///workspace/a.txt')).to.be.false;
            selectedNodes = [targetNode];
            (0, chai_1.expect)(await widget.pasteFiles('')).to.be.false;
            (0, chai_1.expect)(infoMessages).to.have.lengthOf(0);
        });
    });
    describe('asPastedFileUri', () => {
        it('should interpret UNC paths as file URIs', () => {
            const uri = widget['asPastedFileUri']('\\\\server\\share\\f.txt');
            (0, chai_1.expect)(uri?.toString()).to.equal(uri_1.default.fromFilePath('\\\\server\\share\\f.txt').toString());
        });
    });
    describe('handlePaste', () => {
        function pasteEvent(text) {
            const event = {
                prevented: 0,
                clipboardData: { getData: () => text },
                preventDefault() {
                    event.prevented++;
                }
            };
            return event;
        }
        it('should consume the event only when clipboard text and a paste target are available', () => {
            const noTarget = pasteEvent('file:///workspace/a.txt');
            widget['handlePaste'](noTarget);
            (0, chai_1.expect)(noTarget.prevented).to.equal(0);
            selectedNodes = [targetNode];
            const noText = pasteEvent('');
            widget['handlePaste'](noText);
            (0, chai_1.expect)(noText.prevented).to.equal(0);
            const pastable = pasteEvent('file:///workspace/a.txt');
            widget['handlePaste'](pastable);
            (0, chai_1.expect)(pastable.prevented).to.equal(1);
        });
        it('should report a failed paste instead of rejecting unhandled', async () => {
            selectedNodes = [targetNode];
            widget.model.copy = () => Promise.reject(new Error('Parent of file has to be a FileStatNode'));
            widget['handlePaste'](pasteEvent('file:///workspace/a.txt'));
            await new Promise(resolve => setTimeout(resolve, 0));
            (0, chai_1.expect)(errorMessages).to.deep.equal(['Parent of file has to be a FileStatNode']);
        });
    });
    describe('canPasteFiles', () => {
        it('should require a paste target', () => {
            (0, chai_1.expect)(widget.canPasteFiles()).to.be.false;
            selectedNodes = [targetNode];
            (0, chai_1.expect)(widget.canPasteFiles()).to.be.true;
        });
        it('should reject empty clipboard text if it is already known', () => {
            selectedNodes = [targetNode];
            (0, chai_1.expect)(widget.canPasteFiles('')).to.be.false;
            (0, chai_1.expect)(widget.canPasteFiles('file:///workspace/a.txt')).to.be.true;
        });
    });
    describe('handleCopy', () => {
        it('should record copied URIs in the file clipboard', () => {
            const sourceNode = { id: 'source', uri: new uri_1.default('file:///workspace/a.txt') };
            selectedNodes = [sourceNode];
            const clipboardEvent = {
                clipboardData: { setData: () => undefined },
                preventDefault: () => undefined
            };
            widget['handleCopy'](clipboardEvent);
            (0, chai_1.expect)(storedClipboardContents).to.deep.equal(['file:///workspace/a.txt']);
        });
    });
});
//# sourceMappingURL=navigator-widget.spec.js.map