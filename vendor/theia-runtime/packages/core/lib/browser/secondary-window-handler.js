"use strict";
// *****************************************************************************
// Copyright (C) 2022 STMicroelectronics, Ericsson, ARM, EclipseSource and others.
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
exports.SecondaryWindowHandler = void 0;
exports.getDefaultRestoreArea = getDefaultRestoreArea;
exports.getAllWidgetsFromSecondaryWindow = getAllWidgetsFromSecondaryWindow;
exports.extractSecondaryWindowRootWidget = extractSecondaryWindowRootWidget;
exports.extractSecondaryWindow = extractSecondaryWindow;
const tslib_1 = require("tslib");
const debounce = require("lodash.debounce");
const inversify_1 = require("inversify");
const widgets_1 = require("./widgets");
const message_service_1 = require("../common/message-service");
const application_shell_1 = require("./shell/application-shell");
const event_1 = require("../common/event");
const secondary_window_service_1 = require("./window/secondary-window-service");
const keybinding_1 = require("./keybinding");
const theia_dock_panel_1 = require("./shell/theia-dock-panel");
const logger_1 = require("../common/logger");
const nls_1 = require("../common/nls");
/** Widgets to be contained inside a DockPanel in the secondary window. */
class SecondaryWindowDockPanelWidget extends secondary_window_service_1.SecondaryWindowRootWidget {
    constructor(dockPanelFactory, dockPanelRendererFactory, closeHandler, secondaryWindow) {
        super();
        this._widgets = [];
        this.secondaryWindow = secondaryWindow;
        const boxLayout = new widgets_1.BoxLayout();
        // reuse same tab bar classes and dock panel id as main window to inherit styling
        const renderer = dockPanelRendererFactory(secondaryWindow.document);
        renderer.tabBarClasses.push(application_shell_1.MAIN_BOTTOM_AREA_CLASS);
        renderer.tabBarClasses.push(application_shell_1.MAIN_AREA_CLASS);
        this.dockPanel = dockPanelFactory({
            disableDragAndDrop: true,
            closeHandler,
            mode: 'multiple-document',
            renderer,
        });
        this.dockPanel.id = theia_dock_panel_1.MAIN_AREA_ID;
        widgets_1.BoxLayout.setStretch(this.dockPanel, 1);
        boxLayout.addWidget(this.dockPanel);
        this.layout = boxLayout;
    }
    get widgets() {
        return this._widgets;
    }
    addWidget(widget, disposeCallback, options) {
        this._widgets.push(widget);
        this.dockPanel.addWidget(widget, options);
        widget.disposed.connect(() => {
            const index = this._widgets.indexOf(widget);
            if (index > -1) {
                this._widgets.splice(index, 1);
            }
            disposeCallback();
        });
        this.dockPanel.activateWidget(widget);
    }
    getTabBar(widget) {
        return this.dockPanel.findTabBar(widget.title);
    }
}
/**
 * Offers functionality to move a widget out of the main window to a newly created window.
 * Widgets must explicitly implement the `ExtractableWidget` interface to support this.
 *
 * This handler manages the opened secondary windows and sets up messaging between them and the Theia main window.
 * In addition, it provides access to the extracted widgets and provides notifications when widgets are added to or removed from this handler.
 *
 */
let SecondaryWindowHandler = class SecondaryWindowHandler {
    constructor() {
        /** List of widgets in secondary windows. */
        this._widgets = [];
        this.onWillAddWidgetEmitter = new event_1.Emitter();
        /** Subscribe to get notified when a widget is added to this handler, i.e. the widget was moved to an secondary window . */
        this.onWillAddWidget = this.onWillAddWidgetEmitter.event;
        this.onDidAddWidgetEmitter = new event_1.Emitter();
        /** Subscribe to get notified when a widget is added to this handler, i.e. the widget was moved to an secondary window . */
        this.onDidAddWidget = this.onDidAddWidgetEmitter.event;
        this.onWillRemoveWidgetEmitter = new event_1.Emitter();
        /** Subscribe to get notified when a widget is removed from this handler, i.e. the widget's window was closed or the widget was disposed. */
        this.onWillRemoveWidget = this.onWillRemoveWidgetEmitter.event;
        this.onDidRemoveWidgetEmitter = new event_1.Emitter();
        /** Subscribe to get notified when a widget is removed from this handler, i.e. the widget's window was closed or the widget was disposed. */
        this.onDidRemoveWidget = this.onDidRemoveWidgetEmitter.event;
    }
    /** @returns List of widgets in secondary windows. */
    get widgets() {
        // Create new array in case the original changes while this is used.
        return [...this._widgets];
    }
    /**
     * Sets up message forwarding from the main window to secondary windows.
     * Does nothing if this service has already been initialized.
     *
     * @param shell The `ApplicationShell` that widgets will be moved out from.
     * @param dockPanelRendererFactory A factory function to create a `DockPanelRenderer` for use in secondary windows.
     */
    init(shell, dockPanelRendererFactory) {
        if (this.applicationShell) {
            // Already initialized
            return;
        }
        this.applicationShell = shell;
        this.dockPanelRendererFactory = dockPanelRendererFactory;
        this.secondaryWindowService.beforeWidgetRestore(([widget, window]) => this.removeWidget(widget, window));
    }
    /**
     *  Moves the given widget to a new window.
     *
     * @param widget the widget to extract
     */
    moveWidgetToSecondaryWindow(widget) {
        if (!this.applicationShell) {
            this.logger.error('Widget cannot be extracted because the WidgetExtractionHandler has not been initialized.');
            return;
        }
        if (!widget.isExtractable) {
            this.logger.error('Widget is not extractable.', widget.id);
            return;
        }
        const newWindow = this.secondaryWindowService.createSecondaryWindow(widget, this.applicationShell);
        if (!newWindow) {
            this.messageService.error('The widget could not be moved to a secondary window because the window creation failed. Please make sure to allow popups.');
            return;
        }
        const mainWindowTitle = document.title;
        newWindow.addEventListener('load', () => {
            this.keybindings.registerEventListeners(newWindow);
            // Use the widget's title as the window title
            // Even if the widget's label were malicious, this should be safe against XSS because the HTML standard defines this is inserted via a text node.
            // See https://html.spec.whatwg.org/multipage/dom.html#document.title
            newWindow.document.title = `${widget.title.label} — ${mainWindowTitle}`;
            this.setupHtmlLanguageAttributes(newWindow.document.documentElement);
            const element = newWindow.document.getElementById('widget-host');
            if (!element) {
                this.logger.error('Could not find dom element to attach to in secondary window');
                return;
            }
            this.onWillAddWidgetEmitter.fire([widget, newWindow]);
            widget.secondaryWindow = newWindow;
            widget.previousArea = this.applicationShell.getAreaFor(widget);
            const rootWidget = new SecondaryWindowDockPanelWidget(this.dockPanelFactory, this.dockPanelRendererFactory, this.onTabCloseRequested, newWindow);
            rootWidget.defaultRestoreArea = widget.previousArea;
            rootWidget.addClass('secondary-widget-root');
            rootWidget.addClass('monaco-workbench'); // needed for compatility with VSCode styles
            widgets_1.Widget.attach(rootWidget, element);
            if ((0, secondary_window_service_1.isSecondaryWindow)(newWindow)) {
                newWindow.rootWidget = rootWidget;
            }
            rootWidget.addWidget(widget, () => {
                this.onWidgetRemove(widget, newWindow, rootWidget);
            });
            widget.show();
            widget.update();
            this.addWidget(widget, newWindow);
            // debounce to avoid rapid updates while resizing the secondary window
            const updateWidget = debounce(() => {
                rootWidget.update();
            }, 100);
            newWindow.addEventListener('resize', () => {
                updateWidget();
            });
            widget.activate();
        });
    }
    setupHtmlLanguageAttributes(element) {
        nls_1.nls.setHtmlLang(element);
        nls_1.nls.setHtmlNoTranslate(element);
    }
    onWidgetRemove(widget, newWindow, rootWidget) {
        // Close the window if the widget is disposed, e.g. by a command closing all widgets.
        this.onWillRemoveWidgetEmitter.fire([widget, newWindow]);
        this.removeWidget(widget, newWindow);
        if (!newWindow.closed && rootWidget.widgets.length === 0) {
            // no remaining widgets in window -> close the window
            newWindow.close();
        }
    }
    addWidgetToSecondaryWindow(widget, secondaryWindow, options) {
        const rootWidget = (0, secondary_window_service_1.isSecondaryWindow)(secondaryWindow) ? secondaryWindow.rootWidget : undefined;
        if (!rootWidget) {
            this.logger.error('Given secondary window no known root.');
            return;
        }
        // we allow to add any widget to an existing secondary window unless it is marked as not extractable or is already extracted
        if (widgets_1.ExtractableWidget.is(widget)) {
            if (!widget.isExtractable) {
                this.logger.error('Widget is not extractable.', widget.id);
                return;
            }
            if (widget.secondaryWindow !== undefined) {
                this.logger.error('Widget is extracted already.', widget.id);
                return;
            }
            widget.secondaryWindow = secondaryWindow;
            widget.previousArea = this.applicationShell.getAreaFor(widget);
        }
        rootWidget.addWidget(widget, () => {
            this.onWidgetRemove(widget, secondaryWindow, rootWidget);
        }, options);
        widget.show();
        widget.update();
        this.addWidget(widget, secondaryWindow);
        widget.activate();
    }
    onTabCloseRequested(_sender, _args) {
        // return false to keep default behavior
        // override this method if you want to move tabs back instead of closing them
        return false;
    }
    /**
     * If the given widget is tracked by this handler, activate it and focus its secondary window.
     *
     * @param widgetId The widget to activate specified by its id
     * @returns The activated `ExtractableWidget` or `undefined` if the given widget id is unknown to this handler.
     */
    activateWidget(widgetId) {
        const trackedWidget = this.revealWidget(widgetId);
        trackedWidget?.activate();
        return trackedWidget;
    }
    /**
     * If the given widget is tracked by this handler, reveal it by focussing its secondary window.
     *
     * @param widgetId The widget to reveal specified by its id
     * @returns The revealed `ExtractableWidget` or `undefined` if the given widget id is unknown to this handler.
     */
    revealWidget(widgetId) {
        const trackedWidget = this._widgets.find(w => w.id === widgetId);
        if (trackedWidget && this.getFocusedWindow()) {
            if (widgets_1.ExtractableWidget.is(trackedWidget)) {
                this.secondaryWindowService.focus(trackedWidget.secondaryWindow);
                return trackedWidget;
            }
            else {
                const window = extractSecondaryWindow(trackedWidget);
                if (window) {
                    this.secondaryWindowService.focus(window);
                    return trackedWidget;
                }
            }
        }
        return undefined;
    }
    getFocusedWindow() {
        return window.document.hasFocus() ? window : this.secondaryWindowService.getWindows().find(candidate => candidate.document.hasFocus());
    }
    addWidget(widget, win) {
        if (!this._widgets.includes(widget)) {
            this._widgets.push(widget);
            this.onDidAddWidgetEmitter.fire([widget, win]);
        }
    }
    removeWidget(widget, win) {
        const index = this._widgets.indexOf(widget);
        if (index > -1) {
            this._widgets.splice(index, 1);
            this.onDidRemoveWidgetEmitter.fire([widget, win]);
        }
    }
    getTabBarFor(widget) {
        const secondaryWindowRootWidget = extractSecondaryWindowRootWidget(widget);
        if (secondaryWindowRootWidget && secondaryWindowRootWidget.getTabBar) {
            return secondaryWindowRootWidget.getTabBar(widget);
        }
        return undefined;
    }
};
exports.SecondaryWindowHandler = SecondaryWindowHandler;
tslib_1.__decorate([
    (0, inversify_1.inject)(keybinding_1.KeybindingRegistry),
    tslib_1.__metadata("design:type", keybinding_1.KeybindingRegistry)
], SecondaryWindowHandler.prototype, "keybindings", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(theia_dock_panel_1.TheiaDockPanel.Factory),
    tslib_1.__metadata("design:type", Function)
], SecondaryWindowHandler.prototype, "dockPanelFactory", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(logger_1.ILogger),
    (0, inversify_1.named)('core:SecondaryWindowHandler'),
    tslib_1.__metadata("design:type", Object)
], SecondaryWindowHandler.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(message_service_1.MessageService),
    tslib_1.__metadata("design:type", message_service_1.MessageService)
], SecondaryWindowHandler.prototype, "messageService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(secondary_window_service_1.SecondaryWindowService),
    tslib_1.__metadata("design:type", Object)
], SecondaryWindowHandler.prototype, "secondaryWindowService", void 0);
exports.SecondaryWindowHandler = SecondaryWindowHandler = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], SecondaryWindowHandler);
function getDefaultRestoreArea(window) {
    if ((0, secondary_window_service_1.isSecondaryWindow)(window) && window.rootWidget !== undefined) {
        return window.rootWidget.defaultRestoreArea;
    }
    return undefined;
}
function getAllWidgetsFromSecondaryWindow(window) {
    if ((0, secondary_window_service_1.isSecondaryWindow)(window) && window.rootWidget !== undefined) {
        return window.rootWidget.widgets;
    }
    return undefined;
}
function extractSecondaryWindowRootWidget(widget) {
    if (!widget) {
        return undefined;
    }
    //  check two levels of parent hierarchy, usually a root widget would have nested layout widget
    if (widget.parent instanceof secondary_window_service_1.SecondaryWindowRootWidget) {
        return widget.parent;
    }
    if (widget.parent?.parent instanceof secondary_window_service_1.SecondaryWindowRootWidget) {
        return widget.parent.parent;
    }
}
function extractSecondaryWindow(widget) {
    if (!widget) {
        return undefined;
    }
    if (widgets_1.ExtractableWidget.is(widget)) {
        return widget.secondaryWindow;
    }
    if (widget instanceof secondary_window_service_1.SecondaryWindowRootWidget) {
        return widget.secondaryWindow;
    }
    const secondaryWindowRootWidget = extractSecondaryWindowRootWidget(widget);
    if (secondaryWindowRootWidget) {
        return secondaryWindowRootWidget.secondaryWindow;
    }
    return undefined;
}
//# sourceMappingURL=secondary-window-handler.js.map