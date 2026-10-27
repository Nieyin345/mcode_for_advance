"use strict";
// *****************************************************************************
// Copyright (C) 2026 JuliaHub, Inc. and others.
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
// `languages-main` transitively pulls in Monaco and several frontend modules that touch `document`
// at module-load time.
const disableJSDOM = (0, jsdom_1.enableJSDOM)();
const chai_1 = require("chai");
const monaco = require("@theia/monaco-editor-core");
const window_1 = require("@theia/monaco-editor-core/esm/vs/base/browser/window");
const uri_1 = require("@theia/core/lib/common/uri");
const expect_1 = require("@theia/core/lib/common/test/expect");
const common_1 = require("@theia/notebook/lib/common");
const languages_main_1 = require("./languages-main");
after(() => disableJSDOM());
const notebookUri = new uri_1.URI('file:///notebook.ipynb');
const cellHandle = 3;
const cellComponents = common_1.CellUri.generate(notebookUri, cellHandle).toComponents();
function createNotebookModel(handles) {
    const edits = [];
    return {
        edits,
        getCellIndexByHandle: handle => handles.indexOf(handle),
        applyEdits: applied => { edits.push(applied); }
    };
}
/**
 * Bypasses the constructor's RPC/container wiring.
 */
function createLanguagesMain(notebook) {
    const languagesMain = Object.create(languages_main_1.LanguagesMainImpl.prototype);
    languagesMain.notebookService = {
        getNotebookEditorModel: (uri) => uri.toString() === notebookUri.toString() ? notebook : undefined
    };
    return languagesMain;
}
describe('LanguagesMainImpl#$changeLanguage', () => {
    before(() => {
        // Resolving a language id boots Monaco's standalone services, whose theme service reaches for
        // DOM APIs JSDOM does not provide. Monaco captures its window at module load.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        global.CSS ??= { escape: (value) => value };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        window_1.mainWindow.matchMedia ??= () => ({ matches: false, addEventListener: () => { }, removeEventListener: () => { } });
        monaco.languages.register({ id: 'julia' });
    });
    it('applies a cell language edit for a notebook cell', async () => {
        const notebook = createNotebookModel([1, 2, cellHandle]);
        const languagesMain = createLanguagesMain(notebook);
        await languagesMain.$changeLanguage(cellComponents, 'julia');
        (0, chai_1.expect)(notebook.edits).to.deep.equal([[{ editType: 4 /* CellEditType.CellLanguage */, index: 2, language: 'julia' }]]);
    });
    it('rejects for a cell of a notebook that is not open', async () => {
        const languagesMain = createLanguagesMain();
        await (0, expect_1.expectThrowsAsync)(languagesMain.$changeLanguage(cellComponents, 'julia'), 'Invalid uri');
    });
    it('rejects for a cell handle the notebook does not know', async () => {
        const languagesMain = createLanguagesMain(createNotebookModel([1, 2]));
        await (0, expect_1.expectThrowsAsync)(languagesMain.$changeLanguage(cellComponents, 'julia'), 'Invalid uri');
    });
    it('rejects an unknown language id before touching the notebook', async () => {
        const notebook = createNotebookModel([cellHandle]);
        const languagesMain = createLanguagesMain(notebook);
        await (0, expect_1.expectThrowsAsync)(languagesMain.$changeLanguage(cellComponents, 'no-such-language'), /Unknown language ID/);
        (0, chai_1.expect)(notebook.edits).to.be.empty;
    });
});
//# sourceMappingURL=languages-main.spec.js.map