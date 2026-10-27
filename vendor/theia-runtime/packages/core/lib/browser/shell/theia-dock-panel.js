"use strict";
// *****************************************************************************
// Copyright (C) 2018 TypeFox and others.
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
exports.TheiaDockPanel = exports.BOTTOM_AREA_ID = exports.MAIN_AREA_ID = exports.ACTIVE_TABBAR_CLASS = void 0;
const algorithm_1 = require("@lumino/algorithm");
const widgets_1 = require("@lumino/widgets");
const signaling_1 = require("@lumino/signaling");
const disposable_1 = require("../../common/disposable");
const common_1 = require("../../common");
const tab_bars_1 = require("./tab-bars");
exports.ACTIVE_TABBAR_CLASS = 'theia-tabBar-active';
exports.MAIN_AREA_ID = 'theia-main-content-panel';
exports.BOTTOM_AREA_ID = 'theia-bottom-content-panel';
/**
 * This specialization of DockPanel adds various events that are used for implementing the
 * side panels of the application shell.
 */
class TheiaDockPanel extends widgets_1.DockPanel {
    get onDidChangeCurrent() {
        return this.onDidChangeCurrentEmitter.event;
    }
    constructor(options, preferences, maximizeCallback) {
        super(options);
        this.preferences = preferences;
        this.maximizeCallback = maximizeCallback;
        /**
         * Emitted when a widget is added to the panel.
         */
        this.widgetAdded = new signaling_1.Signal(this);
        /**
         * Emitted when a widget is activated by calling `activateWidget`.
         */
        this.widgetActivated = new signaling_1.Signal(this);
        /**
         * Emitted when a widget is removed from the panel.
         */
        this.widgetRemoved = new signaling_1.Signal(this);
        this.onDidChangeCurrentEmitter = new common_1.Emitter();
        this.disableDND = false;
        this.tabWithDNDDisabledStyling = undefined;
        this.toDisposeOnMarkAsCurrent = new disposable_1.DisposableCollection();
        this.disableDND = TheiaDockPanel.isTheiaDockPanelIOptions(options) && options.disableDragAndDrop;
        this['_onCurrentChanged'] = (sender, args) => {
            this.markAsCurrent(args.currentTitle || undefined);
            super['_onCurrentChanged'](sender, args);
        };
        this['_createTabBar'] = () => {
            // necessary for https://github.com/eclipse-theia/theia/issues/15273
            const tabBar = super['_createTabBar']();
            if (tabBar instanceof tab_bars_1.ToolbarAwareTabBar) {
                tabBar.setDockPanel(this);
            }
            if (this.disableDND) {
                tabBar['tabDetachRequested'].disconnect(this['_onTabDetachRequested'], this);
                tabBar['tabDetachRequested'].connect(this.onTabDetachRequestedWithDisabledDND, this);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, no-null/no-null
                let dragDataValue = null;
                Object.defineProperty(tabBar, '_dragData', {
                    get: () => dragDataValue,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    set: (value) => {
                        dragDataValue = value;
                        // eslint-disable-next-line no-null/no-null
                        if (value === null) {
                            this.onNullTabDragDataWithDisabledDND();
                        }
                    },
                    configurable: true
                });
            }
            return tabBar;
        };
        this['_onTabActivateRequested'] = (sender, args) => {
            this.markAsCurrent(args.title);
            super['_onTabActivateRequested'](sender, args);
        };
        this['_onTabCloseRequested'] = (sender, args) => {
            if (TheiaDockPanel.isTheiaDockPanelIOptions(options) && options.closeHandler !== undefined) {
                if (options.closeHandler(sender, args)) {
                    return;
                }
            }
            super['_onTabCloseRequested'](sender, args);
        };
    }
    onTabDetachRequestedWithDisabledDND(sender, args) {
        // don't process the detach request at all. We still want to support other drag starts, e.g. tab reorder
        // provide visual feedback that DnD is disabled by adding not-allowed class
        const tab = sender.contentNode.children[args.index];
        if (tab) {
            tab.classList.add('theia-drag-not-allowed');
            this.tabWithDNDDisabledStyling = tab;
        }
    }
    onNullTabDragDataWithDisabledDND() {
        if (this.tabWithDNDDisabledStyling) {
            this.tabWithDNDDisabledStyling.classList.remove('theia-drag-not-allowed');
            this.tabWithDNDDisabledStyling = undefined;
        }
    }
    handleEvent(event) {
        if (this.disableDND) {
            switch (event.type) {
                case 'lm-dragenter':
                case 'lm-dragleave':
                case 'lm-dragover':
                case 'lm-drop':
                    /* no-op */
                    break;
                default:
                    super.handleEvent(event);
            }
        }
        super.handleEvent(event);
    }
    toggleMaximized() {
        if (this.maximizeCallback) {
            this.maximizeCallback(this);
        }
    }
    isElectron() {
        return common_1.environment.electron.is();
    }
    get currentTitle() {
        return this._currentTitle;
    }
    get currentTabBar() {
        return this._currentTitle && this.findTabBar(this._currentTitle);
    }
    findTabBar(title) {
        return (0, algorithm_1.find)(this.tabBars(), bar => bar.titles.includes(title));
    }
    markAsCurrent(title) {
        this.toDisposeOnMarkAsCurrent.dispose();
        this._currentTitle = title;
        this.markActiveTabBar(title);
        if (title) {
            const resetCurrent = () => this.markAsCurrent(undefined);
            title.owner.disposed.connect(resetCurrent);
            this.toDisposeOnMarkAsCurrent.push(disposable_1.Disposable.create(() => title.owner.disposed.disconnect(resetCurrent)));
        }
        this.onDidChangeCurrentEmitter.fire(title);
    }
    markActiveTabBar(title) {
        const tabBars = (0, algorithm_1.toArray)(this.tabBars());
        tabBars.forEach(tabBar => tabBar.removeClass(exports.ACTIVE_TABBAR_CLASS));
        const activeTabBar = title && this.findTabBar(title);
        if (activeTabBar) {
            activeTabBar.addClass(exports.ACTIVE_TABBAR_CLASS);
        }
        else if (tabBars.length > 0) {
            // At least one tabbar needs to be active
            tabBars[0].addClass(exports.ACTIVE_TABBAR_CLASS);
        }
    }
    addWidget(widget, options) {
        if (this.mode === 'single-document' && widget.parent === this) {
            return;
        }
        super.addWidget(widget, options);
        if (options?.closeRef) {
            options.ref?.close();
        }
        this.widgetAdded.emit(widget);
        this.markActiveTabBar(widget.title);
    }
    activateWidget(widget) {
        super.activateWidget(widget);
        this.widgetActivated.emit(widget);
        this.markActiveTabBar(widget.title);
    }
    onChildRemoved(msg) {
        super.onChildRemoved(msg);
        this.widgetRemoved.emit(msg.child);
    }
    nextTabBarWidget(widget) {
        const current = this.findTabBar(widget.title);
        const next = current && this.nextTabBarInPanel(current);
        return next && next.currentTitle && next.currentTitle.owner || undefined;
    }
    nextTabBarInPanel(tabBar) {
        const tabBars = (0, algorithm_1.toArray)(this.tabBars());
        const index = tabBars.indexOf(tabBar);
        if (index !== -1) {
            return tabBars[index + 1];
        }
        return undefined;
    }
    previousTabBarWidget(widget) {
        const current = this.findTabBar(widget.title);
        const previous = current && this.previousTabBarInPanel(current);
        return previous && previous.currentTitle && previous.currentTitle.owner || undefined;
    }
    previousTabBarInPanel(tabBar) {
        const tabBars = (0, algorithm_1.toArray)(this.tabBars());
        const index = tabBars.indexOf(tabBar);
        if (index !== -1) {
            return tabBars[index - 1];
        }
        return undefined;
    }
    dispose() {
        super.dispose();
        this.onDidChangeCurrentEmitter.dispose();
        this._currentTitle = undefined;
        this.toDisposeOnMarkAsCurrent.dispose();
    }
}
exports.TheiaDockPanel = TheiaDockPanel;
(function (TheiaDockPanel) {
    TheiaDockPanel.Factory = Symbol('TheiaDockPanel#Factory');
    function isTheiaDockPanelIOptions(options) {
        if (options === undefined) {
            return false;
        }
        if ('disableDragAndDrop' in options) {
            if (options.disableDragAndDrop !== undefined && typeof options.disableDragAndDrop !== 'boolean') {
                return false;
            }
        }
        if ('closeHandler' in options) {
            if (options.closeHandler !== undefined && typeof options.closeHandler !== 'function') {
                return false;
            }
        }
        return true;
    }
    TheiaDockPanel.isTheiaDockPanelIOptions = isTheiaDockPanelIOptions;
})(TheiaDockPanel || (exports.TheiaDockPanel = TheiaDockPanel = {}));
//# sourceMappingURL=theia-dock-panel.js.map