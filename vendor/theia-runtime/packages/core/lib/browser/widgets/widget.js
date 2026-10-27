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
exports.EventListenerObject = exports.BaseWidget = exports.UnsafeWidgetUtilities = exports.DEFAULT_SCROLL_OPTIONS = exports.LOCKED_CLASS = exports.PINNED_CLASS = exports.FOCUS_CLASS = exports.SELECTED_CLASS = exports.CODICON_LOADING_CLASSES = exports.BUSY_CLASS = exports.COLLAPSED_CLASS = exports.CODICON_TREE_ITEM_CLASSES = exports.EXPANSION_TOGGLE_CLASS = exports.DISABLED_CLASS = exports.ACTION_ITEM = void 0;
exports.codiconArray = codiconArray;
exports.codicon = codicon;
exports.setEnabled = setEnabled;
exports.createIconButton = createIconButton;
exports.addEventListener = addEventListener;
exports.addKeyListener = addKeyListener;
exports.addClipboardListener = addClipboardListener;
exports.waitForClosed = waitForClosed;
exports.waitForRevealed = waitForRevealed;
exports.waitForHidden = waitForHidden;
exports.isPinned = isPinned;
exports.pin = pin;
exports.unpin = unpin;
exports.isLocked = isLocked;
exports.lock = lock;
exports.unlock = unlock;
exports.togglePinned = togglePinned;
const tslib_1 = require("tslib");
/* eslint-disable @typescript-eslint/no-explicit-any */
const inversify_1 = require("inversify");
const widgets_1 = require("@lumino/widgets");
const messaging_1 = require("@lumino/messaging");
const common_1 = require("../../common");
const keys_1 = require("../keyboard/keys");
const perfect_scrollbar_1 = require("perfect-scrollbar");
(0, inversify_1.decorate)((0, inversify_1.injectable)(), widgets_1.Widget);
(0, inversify_1.decorate)((0, inversify_1.unmanaged)(), widgets_1.Widget, 0);
tslib_1.__exportStar(require("@lumino/widgets"), exports);
tslib_1.__exportStar(require("@lumino/messaging"), exports);
exports.ACTION_ITEM = 'action-label';
function codiconArray(name, actionItem = false) {
    const array = ['codicon', `codicon-${name}`];
    if (actionItem) {
        array.push(exports.ACTION_ITEM);
    }
    return array;
}
function codicon(name, actionItem = false) {
    return `codicon codicon-${name}${actionItem ? ` ${exports.ACTION_ITEM}` : ''}`;
}
exports.DISABLED_CLASS = 'theia-mod-disabled';
exports.EXPANSION_TOGGLE_CLASS = 'theia-ExpansionToggle';
exports.CODICON_TREE_ITEM_CLASSES = codiconArray('chevron-down');
exports.COLLAPSED_CLASS = 'theia-mod-collapsed';
exports.BUSY_CLASS = 'theia-mod-busy';
exports.CODICON_LOADING_CLASSES = codiconArray('loading');
exports.SELECTED_CLASS = 'theia-mod-selected';
exports.FOCUS_CLASS = 'theia-mod-focus';
exports.PINNED_CLASS = 'theia-mod-pinned';
exports.LOCKED_CLASS = 'theia-mod-locked';
exports.DEFAULT_SCROLL_OPTIONS = {
    suppressScrollX: true,
    minScrollbarLength: 35,
};
/**
 * At a number of places in the code, we have effectively reimplemented Lumino's Widget.attach and Widget.detach,
 * but omitted the checks that Lumino expects to be performed for those operations. That is a bad idea, because it
 * means that we are telling widgets that they are attached or detached when not all the conditions that should apply
 * do apply. We should explicitly mark those locations so that we know where we should go fix them later.
 */
var UnsafeWidgetUtilities;
(function (UnsafeWidgetUtilities) {
    /**
     * Ordinarily, the following checks should be performed before detaching a widget:
     * It should not be the child of another widget
     * It should be attached and it should be a child of document.body
     */
    function detach(widget) {
        messaging_1.MessageLoop.sendMessage(widget, widgets_1.Widget.Msg.BeforeDetach);
        widget.node.remove();
        messaging_1.MessageLoop.sendMessage(widget, widgets_1.Widget.Msg.AfterDetach);
    }
    UnsafeWidgetUtilities.detach = detach;
    ;
    /**
     * @param ref The child of the host element to insert the widget before.
     * Ordinarily the following checks should be performed:
     * The widget should have no parent
     * The widget should not be attached, and its node should not be a child of document.body
     * The host should be a child of document.body
     * We often violate the last condition.
     */
    // eslint-disable-next-line no-null/no-null
    function attach(widget, host, ref = null) {
        messaging_1.MessageLoop.sendMessage(widget, widgets_1.Widget.Msg.BeforeAttach);
        host.insertBefore(widget.node, ref);
        messaging_1.MessageLoop.sendMessage(widget, widgets_1.Widget.Msg.AfterAttach);
    }
    UnsafeWidgetUtilities.attach = attach;
    ;
})(UnsafeWidgetUtilities || (exports.UnsafeWidgetUtilities = UnsafeWidgetUtilities = {}));
let BaseWidget = class BaseWidget extends widgets_1.Widget {
    constructor(options) {
        super(options);
        this.onScrollYReachEndEmitter = new common_1.Emitter();
        this.onScrollYReachEnd = this.onScrollYReachEndEmitter.event;
        this.onScrollUpEmitter = new common_1.Emitter();
        this.onScrollUp = this.onScrollUpEmitter.event;
        this.onDidChangeVisibilityEmitter = new common_1.Emitter();
        this.onDidChangeVisibility = this.onDidChangeVisibilityEmitter.event;
        this.onDidDisposeEmitter = new common_1.Emitter();
        this.onDidDispose = this.onDidDisposeEmitter.event;
        this.toDispose = new common_1.DisposableCollection(this.onDidDisposeEmitter, common_1.Disposable.create(() => this.onDidDisposeEmitter.fire()), common_1.Disposable.create(() => this.toDisposeOnDetach.dispose()), this.onScrollYReachEndEmitter, this.onScrollUpEmitter, this.onDidChangeVisibilityEmitter);
        this.toDisposeOnDetach = new common_1.DisposableCollection();
    }
    get isVisible() {
        // Reverted to @lumino/widgets pre-2.7.0 behavior using the IsVisible flag instead of the recursive parent check.
        // Theia relies on this flag-based implementation and we need to transition to the new behavior in a follow-up (GH-16585)
        return this.testFlag(widgets_1.Widget.Flag.IsVisible);
    }
    dispose() {
        if (this.isDisposed) {
            return;
        }
        super.dispose();
        this.toDispose.dispose();
    }
    onCloseRequest(msg) {
        super.onCloseRequest(msg);
        this.dispose();
    }
    onBeforeAttach(msg) {
        if (this.title.iconClass === '') {
            this.title.iconClass = 'no-icon';
        }
        super.onBeforeAttach(msg);
    }
    onAfterDetach(msg) {
        if (this.title.iconClass === 'no-icon') {
            this.title.iconClass = '';
        }
        super.onAfterDetach(msg);
    }
    onBeforeDetach(msg) {
        this.toDisposeOnDetach.dispose();
        super.onBeforeDetach(msg);
    }
    onAfterAttach(msg) {
        super.onAfterAttach(msg);
        if (this.scrollOptions) {
            (async () => {
                const container = await this.getScrollContainer();
                container.style.overflow = 'hidden';
                this.scrollBar = new perfect_scrollbar_1.default(container, this.scrollOptions);
                this.disableScrollBarFocus(container);
                this.toDisposeOnDetach.push(addEventListener(container, 'ps-y-reach-end', () => { this.onScrollYReachEndEmitter.fire(undefined); }));
                this.toDisposeOnDetach.push(addEventListener(container, 'ps-scroll-up', () => { this.onScrollUpEmitter.fire(undefined); }));
                this.toDisposeOnDetach.push(common_1.Disposable.create(() => {
                    if (this.scrollBar) {
                        this.scrollBar.destroy();
                        this.scrollBar = undefined;
                    }
                    container.style.overflow = 'initial';
                }));
            })();
        }
    }
    getScrollContainer() {
        return this.node;
    }
    disableScrollBarFocus(scrollContainer) {
        for (const thumbs of [scrollContainer.getElementsByClassName('ps__thumb-x'), scrollContainer.getElementsByClassName('ps__thumb-y')]) {
            for (let i = 0; i < thumbs.length; i++) {
                const element = thumbs.item(i);
                if (element) {
                    element.removeAttribute('tabIndex');
                }
            }
        }
    }
    onUpdateRequest(msg) {
        super.onUpdateRequest(msg);
        if (this.scrollBar) {
            this.scrollBar.update();
        }
    }
    addUpdateListener(element, type, useCapture) {
        this.addEventListener(element, type, e => {
            this.update();
            e.preventDefault();
        }, useCapture);
    }
    addEventListener(element, type, listener, useCapture) {
        this.toDisposeOnDetach.push(addEventListener(element, type, listener, useCapture));
    }
    addKeyListener(element, keysOrKeyCodes, action, ...additionalEventTypes) {
        this.toDisposeOnDetach.push(addKeyListener(element, keysOrKeyCodes, action, ...additionalEventTypes));
    }
    addClipboardListener(element, type, listener) {
        this.toDisposeOnDetach.push(addClipboardListener(element, type, listener));
    }
    getPreviewNode() {
        return this.node;
    }
    setFlag(flag) {
        super.setFlag(flag);
        if (flag === widgets_1.Widget.Flag.IsVisible) {
            this.handleVisiblityChanged(this.isVisible);
        }
    }
    handleVisiblityChanged(isNowVisible) {
        this.onDidChangeVisibilityEmitter.fire(isNowVisible);
    }
    clearFlag(flag) {
        const wasVisible = this.isVisible;
        super.clearFlag(flag);
        const isVisible = this.isVisible;
        if (isVisible !== wasVisible) {
            this.handleVisiblityChanged(isVisible);
        }
    }
};
exports.BaseWidget = BaseWidget;
exports.BaseWidget = BaseWidget = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__param(0, (0, inversify_1.unmanaged)()),
    tslib_1.__metadata("design:paramtypes", [Object])
], BaseWidget);
function setEnabled(element, enabled) {
    element.classList.toggle(exports.DISABLED_CLASS, !enabled);
    element.tabIndex = enabled ? 0 : -1;
}
function createIconButton(...classNames) {
    const icon = document.createElement('i');
    icon.classList.add(...classNames);
    const button = document.createElement('span');
    button.tabIndex = 0;
    button.appendChild(icon);
    return button;
}
var EventListenerObject;
(function (EventListenerObject) {
    function is(listener) {
        return (0, common_1.isObject)(listener) && 'handleEvent' in listener;
    }
    EventListenerObject.is = is;
})(EventListenerObject || (exports.EventListenerObject = EventListenerObject = {}));
function addEventListener(element, type, listener, useCapture) {
    element.addEventListener(type, listener, useCapture);
    return common_1.Disposable.create(() => element.removeEventListener(type, listener, useCapture));
}
function addKeyListener(element, keysOrKeyCodes, action, ...additionalEventTypes) {
    const toDispose = new common_1.DisposableCollection();
    const keyCodePredicate = (() => {
        if (typeof keysOrKeyCodes === 'function') {
            return keysOrKeyCodes;
        }
        else {
            return (actual) => keys_1.KeysOrKeyCodes.toKeyCodes(keysOrKeyCodes).some(k => k.equals(actual));
        }
    })();
    toDispose.push(addEventListener(element, 'keydown', e => {
        const kc = keys_1.KeyCode.createKeyCode(e);
        if (keyCodePredicate(kc)) {
            const result = action(e);
            if (typeof result !== 'boolean' || result) {
                e.stopPropagation();
                e.preventDefault();
            }
        }
    }));
    for (const type of additionalEventTypes) {
        toDispose.push(addEventListener(element, type, e => {
            const result = action(e);
            if (typeof result !== 'boolean' || result) {
                e.stopPropagation();
                e.preventDefault();
            }
        }));
    }
    return toDispose;
}
function addClipboardListener(element, type, listener) {
    const documentListener = (e) => {
        const activeElement = document.activeElement;
        if (activeElement && element.contains(activeElement)) {
            if (EventListenerObject.is(listener)) {
                listener.handleEvent(e);
            }
            else {
                listener.bind(element)(e);
            }
        }
    };
    document.addEventListener(type, documentListener);
    return common_1.Disposable.create(() => document.removeEventListener(type, documentListener));
}
/**
 * Resolves when the given widget is detached and hidden.
 */
function waitForClosed(widget) {
    return waitForVisible(widget, false, false);
}
/**
 * Resolves when the given widget is attached and visible.
 */
function waitForRevealed(widget) {
    return waitForVisible(widget, true, true);
}
/**
 * Resolves when the given widget is hidden regardless of attachment.
 */
function waitForHidden(widget) {
    return waitForVisible(widget, false);
}
function waitForVisible(widget, visible, attached) {
    if ((typeof attached !== 'boolean' || widget.isAttached === attached) &&
        (widget.isVisible === visible || (widget.node.style.visibility !== 'hidden') === visible)) {
        return new Promise(resolve => setTimeout(() => resolve(), 0));
    }
    return new Promise(resolve => {
        const waitFor = () => setTimeout(() => {
            if ((typeof attached !== 'boolean' || widget.isAttached === attached) &&
                (widget.isVisible === visible || (widget.node.style.visibility !== 'hidden') === visible)) {
                setTimeout(() => resolve(), 0);
            }
            else {
                waitFor();
            }
        }, 0);
        waitFor();
    });
}
const pinnedTitles = new Map();
function isPinned(title) {
    const pinnedState = !title.closable && title.className.includes(exports.PINNED_CLASS);
    return pinnedState;
}
function pin(title) {
    const l = () => {
        pinnedTitles.delete(title);
    };
    pinnedTitles.set(title, [title.closable, l]);
    title.owner.disposed.connect(l);
    title.closable = false;
    if (!title.className.includes(exports.PINNED_CLASS)) {
        title.className += ` ${exports.PINNED_CLASS}`;
    }
}
function unpin(title) {
    const entry = pinnedTitles.get(title);
    if (entry) {
        title.owner.disposed.disconnect(entry[1]);
        title.closable = entry[0];
        pinnedTitles.delete(title);
    }
    else {
        title.closable = true;
    }
    title.className = title.className.replace(exports.PINNED_CLASS, '').trim();
}
function isLocked(title) {
    return title.className.includes(exports.LOCKED_CLASS);
}
function lock(title) {
    if (!title.className.includes(exports.LOCKED_CLASS)) {
        title.className += ` ${exports.LOCKED_CLASS}`;
    }
}
function unlock(title) {
    title.className = title.className.replace(exports.LOCKED_CLASS, '').trim();
}
function togglePinned(title) {
    if (title) {
        if (isPinned(title)) {
            unpin(title);
        }
        else {
            pin(title);
        }
    }
}
//# sourceMappingURL=widget.js.map