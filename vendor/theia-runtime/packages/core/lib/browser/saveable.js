"use strict";
// *****************************************************************************
// Copyright (C) 2017 TypeFox and others.
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
exports.ShouldSaveDialog = exports.SaveReason = exports.SaveableWidget = exports.close = exports.Saveable = exports.CompositeSaveable = exports.DelegatingSaveable = void 0;
exports.setDirty = setDirty;
const event_1 = require("../common/event");
const keys_1 = require("./keyboard/keys");
const dialogs_1 = require("./dialogs");
const nls_1 = require("../common/nls");
const common_1 = require("../common");
class DelegatingSaveable {
    constructor() {
        this.dirty = false;
        this.onDirtyChangedEmitter = new event_1.Emitter();
        this.onContentChangedEmitter = new event_1.Emitter();
        this.toDispose = new common_1.DisposableCollection();
    }
    get onDirtyChanged() {
        return this.onDirtyChangedEmitter.event;
    }
    get onContentChanged() {
        return this.onContentChangedEmitter.event;
    }
    async save(options) {
        await this._delegate?.save(options);
    }
    set delegate(delegate) {
        this.toDispose.dispose();
        this.toDispose = new common_1.DisposableCollection();
        this._delegate = delegate;
        this.toDispose.push(delegate.onDirtyChanged(() => {
            this.dirty = delegate.dirty;
            this.onDirtyChangedEmitter.fire();
        }));
        this.toDispose.push(delegate.onContentChanged(() => {
            this.onContentChangedEmitter.fire();
        }));
        if (this.dirty !== delegate.dirty) {
            this.dirty = delegate.dirty;
            this.onDirtyChangedEmitter.fire();
        }
        this.revert = delegate.revert?.bind(delegate);
        this.createSnapshot = delegate.createSnapshot?.bind(delegate);
        this.applySnapshot = delegate.applySnapshot?.bind(delegate);
        this.serialize = delegate.serialize?.bind(delegate);
        this.saveAs = delegate.saveAs?.bind(delegate);
    }
}
exports.DelegatingSaveable = DelegatingSaveable;
class CompositeSaveable {
    constructor() {
        this.isDirty = false;
        this.onDirtyChangedEmitter = new event_1.Emitter();
        this.onContentChangedEmitter = new event_1.Emitter();
        this.toDispose = new common_1.DisposableCollection(this.onDirtyChangedEmitter, this.onContentChangedEmitter);
        this.saveablesMap = new Map();
    }
    get dirty() {
        return this.isDirty;
    }
    get onDirtyChanged() {
        return this.onDirtyChangedEmitter.event;
    }
    get onContentChanged() {
        return this.onContentChangedEmitter.event;
    }
    async save(options) {
        await Promise.all(this.saveables.map(saveable => saveable.save(options)));
    }
    async revert(options) {
        await Promise.all(this.saveables.map(saveable => saveable.revert?.(options)));
    }
    get saveables() {
        return Array.from(this.saveablesMap.keys());
    }
    add(saveable) {
        if (this.saveablesMap.has(saveable)) {
            return;
        }
        const toDispose = new common_1.DisposableCollection();
        this.toDispose.push(toDispose);
        this.saveablesMap.set(saveable, toDispose);
        toDispose.push(common_1.Disposable.create(() => {
            this.saveablesMap.delete(saveable);
        }));
        toDispose.push(saveable.onDirtyChanged(() => {
            const wasDirty = this.isDirty;
            this.isDirty = this.saveables.some(s => s.dirty);
            if (this.isDirty !== wasDirty) {
                this.onDirtyChangedEmitter.fire();
            }
        }));
        toDispose.push(saveable.onContentChanged(() => {
            this.onContentChangedEmitter.fire();
        }));
        if (saveable.dirty && !this.isDirty) {
            this.isDirty = true;
            this.onDirtyChangedEmitter.fire();
        }
    }
    remove(saveable) {
        const toDispose = this.saveablesMap.get(saveable);
        toDispose?.dispose();
        return !!toDispose;
    }
    dispose() {
        this.toDispose.dispose();
    }
}
exports.CompositeSaveable = CompositeSaveable;
var Saveable;
(function (Saveable) {
    let Snapshot;
    (function (Snapshot) {
        function read(snapshot) {
            return 'value' in snapshot ? snapshot.value : (snapshot.read() ?? undefined);
        }
        Snapshot.read = read;
    })(Snapshot = Saveable.Snapshot || (Saveable.Snapshot = {}));
    function isSource(arg) {
        return (0, common_1.isObject)(arg) && is(arg.saveable);
    }
    Saveable.isSource = isSource;
    function is(arg) {
        return (0, common_1.isObject)(arg) && 'dirty' in arg && 'onDirtyChanged' in arg;
    }
    Saveable.is = is;
    function get(arg) {
        if (is(arg)) {
            return arg;
        }
        if (isSource(arg)) {
            return arg.saveable;
        }
        return undefined;
    }
    Saveable.get = get;
    function getDirty(arg) {
        const saveable = get(arg);
        if (saveable && saveable.dirty) {
            return saveable;
        }
        return undefined;
    }
    Saveable.getDirty = getDirty;
    function isDirty(arg) {
        return !!getDirty(arg);
    }
    Saveable.isDirty = isDirty;
    async function save(arg, options) {
        const saveable = get(arg);
        if (saveable) {
            await saveable.save(options);
        }
    }
    Saveable.save = save;
    async function confirmSaveBeforeClose(toClose, others) {
        for (const widget of toClose) {
            const saveable = Saveable.get(widget);
            if (saveable?.dirty) {
                if (!closingWidgetWouldLoseSaveable(widget, others)) {
                    continue;
                }
                const userWantsToSave = await new ShouldSaveDialog(widget).open();
                if (userWantsToSave === undefined) { // User clicked cancel.
                    return undefined;
                }
                else if (userWantsToSave) {
                    await saveable.save();
                }
                else {
                    await saveable.revert?.();
                }
            }
        }
        return true;
    }
    Saveable.confirmSaveBeforeClose = confirmSaveBeforeClose;
    function closingWidgetWouldLoseSaveable(widget, others) {
        const saveable = Saveable.get(widget);
        return !!saveable && !others.some(otherWidget => otherWidget !== widget && Saveable.get(otherWidget) === saveable);
    }
    Saveable.closingWidgetWouldLoseSaveable = closingWidgetWouldLoseSaveable;
})(Saveable || (exports.Saveable = Saveable = {}));
exports.close = Symbol('close');
var SaveableWidget;
(function (SaveableWidget) {
    function is(widget) {
        return !!widget && 'closeWithoutSaving' in widget;
    }
    SaveableWidget.is = is;
    function getDirty(widgets) {
        return get(widgets, Saveable.isDirty);
    }
    SaveableWidget.getDirty = getDirty;
    function* get(widgets, filter = () => true) {
        for (const widget of widgets) {
            if (SaveableWidget.is(widget) && filter(widget)) {
                yield widget;
            }
        }
    }
    SaveableWidget.get = get;
})(SaveableWidget || (exports.SaveableWidget = SaveableWidget = {}));
;
var SaveReason;
(function (SaveReason) {
    SaveReason[SaveReason["Manual"] = 1] = "Manual";
    SaveReason[SaveReason["AfterDelay"] = 2] = "AfterDelay";
    SaveReason[SaveReason["FocusChange"] = 3] = "FocusChange";
})(SaveReason || (exports.SaveReason = SaveReason = {}));
(function (SaveReason) {
    function isManual(reason) {
        return reason === SaveReason.Manual;
    }
    SaveReason.isManual = isManual;
})(SaveReason || (exports.SaveReason = SaveReason = {}));
/**
 * The class name added to the dirty widget's title.
 */
const DIRTY_CLASS = 'theia-mod-dirty';
function setDirty(widget, dirty) {
    const dirtyClass = ` ${DIRTY_CLASS}`;
    widget.title.className = widget.title.className.replace(dirtyClass, '');
    if (dirty) {
        widget.title.className += dirtyClass;
    }
}
class ShouldSaveDialog extends dialogs_1.AbstractDialog {
    constructor(widget) {
        super({
            title: nls_1.nls.localizeByDefault('Do you want to save the changes you made to {0}?', widget.title.label || widget.title.caption)
        }, {
            node: widget.node.ownerDocument.createElement('div')
        });
        this.shouldSave = true;
        const messageNode = this.node.ownerDocument.createElement('div');
        messageNode.textContent = nls_1.nls.localizeByDefault("Your changes will be lost if you don't save them.");
        messageNode.setAttribute('style', 'flex: 1 100%; padding-bottom: calc(var(--theia-ui-padding)*3);');
        this.contentNode.appendChild(messageNode);
        this.appendCloseButton();
        this.dontSaveButton = this.appendDontSaveButton();
        this.appendAcceptButton(nls_1.nls.localizeByDefault('Save'));
    }
    appendDontSaveButton() {
        const button = this.createButton(nls_1.nls.localizeByDefault("Don't Save"));
        this.controlPanel.appendChild(button);
        button.classList.add('secondary');
        return button;
    }
    onAfterAttach(msg) {
        super.onAfterAttach(msg);
        this.addKeyListener(this.dontSaveButton, keys_1.Key.ENTER, () => {
            this.shouldSave = false;
            this.accept();
        }, 'click');
    }
    get value() {
        return this.shouldSave;
    }
    async open(disposeOnResolve) {
        return super.open(disposeOnResolve);
    }
}
exports.ShouldSaveDialog = ShouldSaveDialog;
//# sourceMappingURL=saveable.js.map