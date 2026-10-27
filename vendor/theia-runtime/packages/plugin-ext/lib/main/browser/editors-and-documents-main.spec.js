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
let disableJSDOM = (0, jsdom_1.enableJSDOM)();
const chai_1 = require("chai");
const core_1 = require("@theia/core");
const browser_1 = require("@theia/core/lib/browser");
const saveable_service_1 = require("@theia/core/lib/browser/saveable-service");
const editors_and_documents_main_1 = require("./editors-and-documents-main");
disableJSDOM();
class TestSaveable {
    constructor() {
        this.dirty = true;
        this.onDirtyChanged = new core_1.Emitter().event;
        this.onContentChanged = new core_1.Emitter().event;
        this.saveCount = 0;
    }
    async save() {
        this.saveCount++;
        this.dirty = false;
    }
}
/** Navigatable to the resource, but with nothing to save. */
class TestNavigatableWidget extends browser_1.BaseWidget {
    constructor(uri) {
        super();
        this.uri = uri;
    }
    getResourceUri() {
        return this.uri;
    }
    createMoveToUri() {
        return this.uri;
    }
}
/** Stands in for a `CustomEditorWidget`: saveable and navigatable, but not an `EditorWidget`. */
class TestSaveableWidget extends TestNavigatableWidget {
    constructor() {
        super(...arguments);
        this.saveable = new TestSaveable();
    }
}
function createEditorsAndDocumentsMain(editor, widgets) {
    // Bypass the constructor's RPC/container wiring: `save` and `saveAs` only touch the
    // editor manager, the shell and the saveable service.
    const main = Object.create(editors_and_documents_main_1.EditorsAndDocumentsMain.prototype);
    const fields = main;
    fields.editorManager = { getByUri: async () => editor };
    fields.shell = { widgets };
    fields.saveResourceService = new saveable_service_1.SaveableService();
    return main;
}
describe('EditorsAndDocumentsMain#save', () => {
    before(() => {
        disableJSDOM = (0, jsdom_1.enableJSDOM)();
    });
    after(() => {
        disableJSDOM();
    });
    const uri = new core_1.URI('custom-editor:/some/resource?viewType=test');
    it('saves a saveable widget that the editor manager does not know', async () => {
        const widget = new TestSaveableWidget(uri);
        const main = createEditorsAndDocumentsMain(undefined, [widget]);
        const saved = await main.save(uri);
        (0, chai_1.expect)(widget.saveable.saveCount).to.equal(1);
        (0, chai_1.expect)(saved?.toString()).to.equal(uri.toString());
    });
    it('prefers the text editor when the editor manager has one', async () => {
        const editor = new TestSaveableWidget(uri);
        const custom = new TestSaveableWidget(uri);
        const main = createEditorsAndDocumentsMain(editor, [custom]);
        await main.save(uri);
        (0, chai_1.expect)(editor.saveable.saveCount).to.equal(1);
        (0, chai_1.expect)(custom.saveable.saveCount).to.equal(0);
    });
    it('leaves widgets bound to another resource alone', async () => {
        const other = new TestSaveableWidget(new core_1.URI('custom-editor:/other/resource'));
        const main = createEditorsAndDocumentsMain(undefined, [other]);
        const saved = await main.save(uri);
        (0, chai_1.expect)(other.saveable.saveCount).to.equal(0);
        (0, chai_1.expect)(saved).to.be.undefined;
    });
    it('ignores a widget that is navigatable to the resource but not saveable', async () => {
        const main = createEditorsAndDocumentsMain(undefined, [new TestNavigatableWidget(uri)]);
        (0, chai_1.expect)(await main.save(uri)).to.be.undefined;
    });
    it('resolves saveAs through the same fallback', async () => {
        const widget = new TestSaveableWidget(uri);
        const main = createEditorsAndDocumentsMain(undefined, [widget]);
        const saveAsTargets = [];
        // `SaveableService.canSaveAs` is unconditionally false on the base class, so the
        // service is stubbed to reach the `saveAs` branch at all.
        main.saveResourceService = {
            canSaveAs: (candidate) => candidate === widget,
            saveAs: async (target) => { saveAsTargets.push(target); return uri; }
        };
        const saved = await main.saveAs(uri);
        (0, chai_1.expect)(saveAsTargets).to.deep.equal([widget]);
        (0, chai_1.expect)(saved?.toString()).to.equal(uri.toString());
    });
});
//# sourceMappingURL=editors-and-documents-main.spec.js.map