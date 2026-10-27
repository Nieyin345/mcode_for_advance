"use strict";
/********************************************************************************
 * Copyright (C) 2022 Arm and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
 ********************************************************************************/
Object.defineProperty(exports, "__esModule", { value: true });
exports.AutoSaveThrottle = exports.SaveableService = exports.SaveErrorChecker = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("inversify");
const common_1 = require("../common");
const navigatable_types_1 = require("./navigatable-types");
const saveable_1 = require("./saveable");
const widgets_1 = require("./widgets");
const window_focus_service_1 = require("./window/window-focus-service");
const throttle = require("lodash.throttle");
exports.SaveErrorChecker = Symbol('SaveErrorChecker');
let SaveableService = class SaveableService {
    constructor() {
        this.saveThrottles = new Map();
        this.saveMode = 'off';
        this.saveDelay = 1000;
        this.saveWhenNoErrors = false;
        this.onDidAutoSaveChangeEmitter = new common_1.Emitter();
        this.onDidAutoSaveDelayChangeEmitter = new common_1.Emitter();
        this.onDidAutoSaveConditionsChangeEmitter = new common_1.Emitter();
    }
    get onDidAutoSaveChange() {
        return this.onDidAutoSaveChangeEmitter.event;
    }
    get onDidAutoSaveDelayChange() {
        return this.onDidAutoSaveDelayChangeEmitter.event;
    }
    get onDidAutoSaveConditionsChange() {
        return this.onDidAutoSaveConditionsChangeEmitter.event;
    }
    get autoSave() {
        return this.saveMode;
    }
    set autoSave(value) {
        this.updateAutoSaveMode(value);
    }
    get autoSaveDelay() {
        return this.saveDelay;
    }
    set autoSaveDelay(value) {
        this.updateAutoSaveDelay(value);
    }
    get autoSaveWhenNoErrors() {
        return this.saveWhenNoErrors;
    }
    set autoSaveWhenNoErrors(value) {
        this.saveWhenNoErrors = value;
    }
    onDidInitializeLayout(app) {
        this.shell = app.shell;
        // Listen to error state changes from all registered error checkers
        for (const checker of this.errorCheckers.getContributions()) {
            checker.onDidErrorStateChange(() => {
                this.onDidAutoSaveConditionsChangeEmitter.fire();
            });
        }
        // Register restored editors first
        for (const widget of this.shell.widgets) {
            const saveable = saveable_1.Saveable.get(widget);
            if (saveable) {
                this.registerSaveable(widget, saveable);
            }
        }
        this.shell.onDidAddWidget(e => {
            const saveable = saveable_1.Saveable.get(e);
            if (saveable) {
                this.registerSaveable(e, saveable);
            }
        });
        this.shell.onDidChangeCurrentWidget(e => {
            if (this.saveMode === 'onFocusChange') {
                const widget = e.oldValue;
                const saveable = saveable_1.Saveable.get(widget);
                if (saveable && widget && this.shouldAutoSave(widget, saveable)) {
                    saveable.save({
                        saveReason: saveable_1.SaveReason.FocusChange
                    });
                }
            }
        });
        this.shell.onDidRemoveWidget(e => {
            this.saveThrottles.get(e)?.dispose();
            this.saveThrottles.delete(e);
        });
        // Save all dirty editors when any application window loses focus
        this.windowFocusService.onDidWindowChangeFocus(({ hasFocus }) => {
            if (!hasFocus) {
                this.saveOnWindowBlur();
            }
        });
    }
    /**
     * Save all dirty saveables when the application window loses focus.
     * Triggered for both `onFocusChange` and `onWindowChange` auto-save modes,
     * matching VSCode's behavior where a window focus loss is a superset of
     * editor focus loss.
     */
    saveOnWindowBlur() {
        if (this.saveMode !== 'onWindowChange' && this.saveMode !== 'onFocusChange') {
            return;
        }
        if (!this.shell) {
            return;
        }
        for (const widget of this.shell.widgets) {
            const saveable = saveable_1.Saveable.get(widget);
            if (saveable && this.shouldAutoSave(widget, saveable)) {
                saveable.save({
                    saveReason: saveable_1.SaveReason.FocusChange
                });
            }
        }
    }
    updateAutoSaveMode(mode) {
        this.saveMode = mode;
        this.onDidAutoSaveChangeEmitter.fire(mode);
        if (mode === 'onFocusChange') {
            // If the new mode is onFocusChange, we need to save all dirty documents that are not focused
            if (!this.shell) {
                // Shell is not ready yet, skip auto-saving widgets
                return;
            }
            const widgets = this.shell.widgets;
            for (const widget of widgets) {
                const saveable = saveable_1.Saveable.get(widget);
                if (saveable && widget !== this.shell.currentWidget && this.shouldAutoSave(widget, saveable)) {
                    saveable.save({
                        saveReason: saveable_1.SaveReason.FocusChange
                    });
                }
            }
        }
    }
    updateAutoSaveDelay(delay) {
        this.saveDelay = delay;
        this.onDidAutoSaveDelayChangeEmitter.fire(delay);
    }
    registerSaveable(widget, saveable) {
        const saveThrottle = new AutoSaveThrottle(saveable, this, () => {
            if (this.saveMode === 'afterDelay' && this.shouldAutoSave(widget, saveable)) {
                saveable.save({
                    saveReason: saveable_1.SaveReason.AfterDelay
                });
            }
        });
        this.saveThrottles.set(widget, saveThrottle);
        this.applySaveableWidget(widget, saveable);
        return saveThrottle;
    }
    shouldAutoSave(widget, saveable) {
        const uri = navigatable_types_1.NavigatableWidget.getUri(widget);
        if (uri?.scheme === common_1.UNTITLED_SCHEME) {
            // Never auto-save untitled documents
            return false;
        }
        if (saveable.autosaveable === false || !saveable.dirty) {
            return false;
        }
        if (this.saveWhenNoErrors && uri) {
            if (this.errorCheckers.getContributions().some(checker => checker.hasErrors(uri))) {
                return false;
            }
        }
        return true;
    }
    applySaveableWidget(widget, saveable) {
        if (saveable_1.SaveableWidget.is(widget)) {
            return;
        }
        const saveableWidget = widget;
        (0, saveable_1.setDirty)(saveableWidget, saveable.dirty);
        saveable.onDirtyChanged(() => (0, saveable_1.setDirty)(saveableWidget, saveable.dirty));
        const closeWithSaving = this.createCloseWithSaving();
        const closeWithoutSaving = async () => {
            const revert = saveable_1.Saveable.closingWidgetWouldLoseSaveable(saveableWidget, Array.from(this.saveThrottles.keys()));
            await this.closeWithoutSaving(saveableWidget, revert);
        };
        Object.assign(saveableWidget, {
            closeWithoutSaving,
            closeWithSaving,
            close: closeWithSaving,
            [saveable_1.close]: saveableWidget.close,
        });
    }
    createCloseWithSaving() {
        let closing = false;
        const doSave = this.closeWithSaving.bind(this);
        return async function (options) {
            if (closing) {
                return;
            }
            closing = true;
            try {
                await doSave(this, options);
            }
            finally {
                closing = false;
            }
        };
    }
    async closeWithSaving(widget, options) {
        const result = await this.shouldSaveWidget(widget, options);
        if (typeof result === 'boolean') {
            if (result) {
                await this.save(widget, {
                    saveReason: saveable_1.SaveReason.AfterDelay
                });
                if (!saveable_1.Saveable.isDirty(widget)) {
                    await widget.closeWithoutSaving();
                }
            }
            else {
                await widget.closeWithoutSaving();
            }
        }
    }
    async shouldSaveWidget(widget, options) {
        if (!saveable_1.Saveable.isDirty(widget)) {
            return false;
        }
        const saveable = saveable_1.Saveable.get(widget);
        if (!saveable) {
            this.logger.warn('Saveable.get returned undefined on a known saveable widget. This is unexpected.');
        }
        // Enter branch if saveable absent since we cannot check autosaveability more definitely.
        if (this.autoSave !== 'off' && (!saveable || this.shouldAutoSave(widget, saveable))) {
            return true;
        }
        const notLastWithDocument = !saveable_1.Saveable.closingWidgetWouldLoseSaveable(widget, Array.from(this.saveThrottles.keys()));
        if (notLastWithDocument) {
            await widget.closeWithoutSaving(false);
            return undefined;
        }
        if (options && options.shouldSave) {
            return options.shouldSave();
        }
        return new saveable_1.ShouldSaveDialog(widget).open();
    }
    async closeWithoutSaving(widget, doRevert = true) {
        const saveable = saveable_1.Saveable.get(widget);
        if (saveable && doRevert && saveable.dirty && saveable.revert) {
            await saveable.revert();
        }
        widget[saveable_1.close]();
        return (0, widgets_1.waitForClosed)(widget);
    }
    /**
     * Indicate if the document can be saved ('Save' command should be disable if not).
     */
    canSave(widget) {
        return saveable_1.Saveable.isDirty(widget) && (this.canSaveNotSaveAs(widget) || this.canSaveAs(widget));
    }
    canSaveNotSaveAs(widget) {
        // By default, we never allow a document to be saved if it is untitled.
        return Boolean(widget && navigatable_types_1.NavigatableWidget.getUri(widget)?.scheme !== common_1.UNTITLED_SCHEME);
    }
    /**
     * Saves the document
     *
     * No op if the widget is not saveable.
     */
    async save(widget, options) {
        if (this.canSaveNotSaveAs(widget)) {
            await saveable_1.Saveable.save(widget, options);
            return navigatable_types_1.NavigatableWidget.getUri(widget);
        }
        else if (this.canSaveAs(widget)) {
            return this.saveAs(widget, options);
        }
    }
    canSaveAs(saveable) {
        return false;
    }
    saveAs(sourceWidget, options) {
        return Promise.reject('Unsupported: The base SaveResourceService does not support saveAs action.');
    }
};
exports.SaveableService = SaveableService;
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.ContributionProvider),
    (0, inversify_1.named)(exports.SaveErrorChecker),
    tslib_1.__metadata("design:type", Object)
], SaveableService.prototype, "errorCheckers", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(window_focus_service_1.WindowFocusService),
    tslib_1.__metadata("design:type", window_focus_service_1.WindowFocusService)
], SaveableService.prototype, "windowFocusService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.ILogger),
    (0, inversify_1.named)('core:SaveableService'),
    tslib_1.__metadata("design:type", Object)
], SaveableService.prototype, "logger", void 0);
exports.SaveableService = SaveableService = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], SaveableService);
class AutoSaveThrottle {
    constructor(saveable, saveService, callback, ...disposables) {
        this._callback = callback;
        this._saveable = saveable;
        this._saveService = saveService;
        this._disposable = new common_1.DisposableCollection(...disposables, saveable.onContentChanged(() => {
            this.throttledSave();
        }), saveable.onDirtyChanged(() => {
            this.throttledSave();
        }), saveService.onDidAutoSaveChange(() => {
            this.throttledSave();
        }), saveService.onDidAutoSaveDelayChange(() => {
            this.throttledSave(true);
        }), saveService.onDidAutoSaveConditionsChange(() => {
            this.throttledSave();
        }));
    }
    throttledSave(reset = false) {
        this._throttle?.cancel();
        if (reset) {
            this._throttle = undefined;
        }
        if (this._saveService.autoSave === 'afterDelay' && this._saveable.dirty) {
            if (!this._throttle) {
                this._throttle = throttle(() => this._callback(), this._saveService.autoSaveDelay, {
                    leading: false,
                    trailing: true
                });
            }
            this._throttle();
        }
    }
    dispose() {
        this._disposable.dispose();
    }
}
exports.AutoSaveThrottle = AutoSaveThrottle;
//# sourceMappingURL=saveable-service.js.map