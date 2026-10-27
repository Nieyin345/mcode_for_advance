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
var NavigationLocationService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.NavigationLocationService = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const logger_1 = require("@theia/core/lib/common/logger");
const opener_service_1 = require("@theia/core/lib/browser/opener-service");
const navigation_location_updater_1 = require("./navigation-location-updater");
const navigation_location_similarity_1 = require("./navigation-location-similarity");
const navigation_location_1 = require("./navigation-location");
/**
 * The navigation location service.
 * It also stores and manages navigation locations and recently closed editors.
 *
 * Since we update the navigation locations as a side effect of UI events (seting the selection, etc.) We sometimes
 * record intermediate locations which are not considered the "final" location we're navigating to.
 * In order to remedy, clients should always invoke "startNavigation" before registering locations and
 * invoke "endNavigation" when done. Only when no more nested navigations are active ist the last registered
 * location transfered to the navigation "stack".
 *
 */
let NavigationLocationService = class NavigationLocationService {
    constructor() {
        this.pointer = -1;
        this.stack = [];
        this.canRegister = true;
        this.recentlyClosedEditors = [];
        this.activeNavigations = { count: 0, lastLocation: undefined };
    }
    static { NavigationLocationService_1 = this; }
    static { this.MAX_STACK_ITEMS = 30; }
    static { this.MAX_RECENTLY_CLOSED_EDITORS = 20; }
    /**
     * Start a logical navigation operation. Invoke this before invoking `registerLocations`
     */
    startNavigation() {
        if (this.canRegister) {
            this.activeNavigations.count++;
            this.logger.debug(`start navigation ${this.activeNavigations.count}`);
            this.logger.trace(new Error('start'));
        }
    }
    /**
     * End a logical navigation operation. Invoke this before after `registerLocations`
     */
    endNavigation() {
        if (this.canRegister) {
            this.activeNavigations.count--;
            this.logger.debug(`end navigation ${this.activeNavigations.count}`);
            this.logger.trace(new Error('end'));
            if (this.activeNavigations.count === 0 && this.activeNavigations.lastLocation !== undefined) {
                this.logger.debug(`ending navigation with location ${JSON.stringify(navigation_location_1.NavigationLocation.toObject(this.activeNavigations.lastLocation[0]))}`);
                const locations = this.activeNavigations.lastLocation;
                this.activeNavigations.lastLocation = undefined;
                this.doRegister(locations);
            }
        }
    }
    /**
     * Convenience method for executing a navigation operation with proper start and end navigation
     * @param navigation The operation changing the location
     * @returns the result of the navigation function
     */
    navigate(navigation) {
        this.startNavigation();
        try {
            return navigation(this);
        }
        finally {
            this.endNavigation();
        }
    }
    /**
     * Registers the give locations into the service.
     */
    register(...locations) {
        if (this.canRegister) {
            if (this.activeNavigations.count > 0) {
                this.activeNavigations.lastLocation = locations;
            }
            else {
                this.logger.warn('no activative navigation', new Error('No active navigation'));
                this.doRegister(locations);
            }
        }
    }
    doRegister(locations) {
        const max = this.maxStackItems();
        [...locations].forEach(location => {
            if (navigation_location_1.ContentChangeLocation.is(location)) {
                this._lastEditLocation = location;
            }
            const current = this.currentLocation();
            this.debug(`Registering new location: ${navigation_location_1.NavigationLocation.toString(location)}.`);
            if (!this.isSimilar(current, location)) {
                this.debug('Before location registration.');
                this.debug(this.stackDump);
                // Just like in VSCode; if we are not at the end of stack, we remove anything after.
                if (this.stack.length > this.pointer + 1) {
                    this.debug(`Discarding all locations after ${this.pointer}.`);
                    this.stack = this.stack.slice(0, this.pointer + 1);
                }
                this.stack.push(location);
                this.pointer = this.stack.length - 1;
                if (this.stack.length > max) {
                    this.debug('Trimming exceeding locations.');
                    this.stack.shift();
                    this.pointer--;
                }
                this.debug('Updating preceding navigation locations.');
                for (let i = this.stack.length - 1; i >= 0; i--) {
                    const candidate = this.stack[i];
                    const update = this.updater.affects(candidate, location);
                    if (update === undefined) {
                        this.debug(`Erasing obsolete location: ${navigation_location_1.NavigationLocation.toString(candidate)}.`);
                        this.stack.splice(i, 1);
                        this.pointer--;
                    }
                    else if (typeof update !== 'boolean') {
                        this.debug(`Updating location at index: ${i} => ${navigation_location_1.NavigationLocation.toString(candidate)}.`);
                        this.stack[i] = update;
                    }
                }
                this.debug('After location registration.');
                this.debug(this.stackDump);
            }
            else {
                if (current) {
                    this.debug(`The new location ${navigation_location_1.NavigationLocation.toString(location)} is similar to the current one: ${navigation_location_1.NavigationLocation.toString(current)}. Aborting.`);
                }
            }
        });
    }
    /**
     * Navigates one back. Returns with the previous location, or `undefined` if it could not navigate back.
     */
    async back() {
        this.debug('Navigating back.');
        if (this.canGoBack()) {
            this.pointer--;
            await this.reveal();
            this.debug(this.stackDump);
            return this.currentLocation();
        }
        this.debug('Cannot navigate back.');
        return undefined;
    }
    /**
     * Navigates one forward. Returns with the next location, or `undefined` if it could not go forward.
     */
    async forward() {
        this.debug('Navigating forward.');
        if (this.canGoForward()) {
            this.pointer++;
            await this.reveal();
            this.debug(this.stackDump);
            return this.currentLocation();
        }
        this.debug('Cannot navigate forward.');
        return undefined;
    }
    /**
     * Checks whether the service can go [`back`](#back).
     */
    canGoBack() {
        return this.pointer >= 1;
    }
    /**
     * Checks whether the service can go [`forward`](#forward).
     */
    canGoForward() {
        return this.pointer >= 0 && this.pointer !== this.stack.length - 1;
    }
    /**
     * Returns with all known navigation locations in chronological order.
     */
    locations() {
        return this.stack;
    }
    /**
     * Returns with the current location.
     */
    currentLocation() {
        return this.stack[this.pointer];
    }
    /**
     * Returns with the location of the most recent edition if any. If there were no modifications,
     * returns `undefined`.
     */
    lastEditLocation() {
        return this._lastEditLocation;
    }
    /**
     * Clears the total history.
     */
    clearHistory() {
        this.stack = [];
        this.pointer = -1;
        this._lastEditLocation = undefined;
        this.recentlyClosedEditors = [];
    }
    /**
     * Reveals the location argument. If not given, reveals the `current location`. Does nothing, if the argument is `undefined`.
     */
    async reveal(location = this.currentLocation()) {
        if (location === undefined) {
            return;
        }
        try {
            this.canRegister = false;
            const { uri } = location;
            const options = this.toOpenerOptions(location);
            await (0, opener_service_1.open)(this.openerService, uri, options);
        }
        catch (e) {
            this.logger.error(`Error occurred while revealing location: ${navigation_location_1.NavigationLocation.toString(location)}.`, e);
        }
        finally {
            this.canRegister = true;
        }
    }
    /**
     * `true` if the two locations are similar.
     */
    isSimilar(left, right) {
        return this.similarity.similar(left, right);
    }
    /**
     * Returns with the number of navigation locations that the application can handle and manage.
     * When the number of locations exceeds this number, old locations will be erased.
     */
    maxStackItems() {
        return NavigationLocationService_1.MAX_STACK_ITEMS;
    }
    /**
     * Returns with the opener option for the location argument.
     */
    toOpenerOptions(location) {
        let { start } = navigation_location_1.NavigationLocation.range(location);
        // Here, the `start` and represents the previous state that has been updated with the `text`.
        // So we calculate the range by appending the `text` length to the `start`.
        if (navigation_location_1.ContentChangeLocation.is(location)) {
            start = { ...start, character: start.character + location.context.text.length };
        }
        return {
            selection: navigation_location_1.Range.create(start, start)
        };
    }
    async debug(message) {
        this.logger.trace(typeof message === 'string' ? message : message());
    }
    get stackDump() {
        return `----- Navigation location stack [${new Date()}] -----
Pointer: ${this.pointer}
${this.stack.map((location, i) => `${i}: ${JSON.stringify(navigation_location_1.NavigationLocation.toObject(location))}`).join('\n')}
----- o -----`;
    }
    /**
     * Get the recently closed editors stack in chronological order.
     *
     * @returns readonly closed editors stack.
     */
    get closedEditorsStack() {
        return this.recentlyClosedEditors;
    }
    /**
     * Get the last recently closed editor.
     *
     * @returns the recently closed editor if it exists.
     */
    getLastClosedEditor() {
        return this.recentlyClosedEditors[this.recentlyClosedEditors.length - 1];
    }
    /**
     * Add the recently closed editor to the history.
     *
     * @param editor the recently closed editor.
     */
    addClosedEditor(editor) {
        this.removeClosedEditor(editor.uri);
        this.recentlyClosedEditors.push(editor);
        // Removes the oldest entry from the history if the maximum size is reached.
        if (this.recentlyClosedEditors.length > NavigationLocationService_1.MAX_RECENTLY_CLOSED_EDITORS) {
            this.recentlyClosedEditors.shift();
        }
    }
    /**
     * Remove all occurrences of the given editor in the history if they exist.
     *
     * @param uri the uri of the editor that should be removed from the history.
     */
    removeClosedEditor(uri) {
        this.recentlyClosedEditors = this.recentlyClosedEditors.filter(e => !uri.isEqual(e.uri));
    }
    storeState() {
        const result = {
            locations: this.stack.map(navigation_location_1.NavigationLocation.toObject)
        };
        return result;
    }
    restoreState(rawState) {
        const state = rawState;
        this.stack = [];
        for (let i = 0; i < state.locations.length; i++) {
            const location = navigation_location_1.NavigationLocation.fromObject(state.locations[i]);
            if (location) {
                this.stack.push(location);
            }
            else {
                this.logger.warn(`Could not restore the state of the editor navigation history for ${JSON.stringify(state.locations[i])}`);
            }
        }
        this.pointer = this.stack.length - 1;
    }
};
exports.NavigationLocationService = NavigationLocationService;
tslib_1.__decorate([
    (0, inversify_1.inject)(logger_1.ILogger),
    (0, inversify_1.named)('editor:NavigationLocationService'),
    tslib_1.__metadata("design:type", Object)
], NavigationLocationService.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(opener_service_1.OpenerService),
    tslib_1.__metadata("design:type", Object)
], NavigationLocationService.prototype, "openerService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(navigation_location_updater_1.NavigationLocationUpdater),
    tslib_1.__metadata("design:type", navigation_location_updater_1.NavigationLocationUpdater)
], NavigationLocationService.prototype, "updater", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(navigation_location_similarity_1.NavigationLocationSimilarity),
    tslib_1.__metadata("design:type", navigation_location_similarity_1.NavigationLocationSimilarity)
], NavigationLocationService.prototype, "similarity", void 0);
exports.NavigationLocationService = NavigationLocationService = NavigationLocationService_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], NavigationLocationService);
//# sourceMappingURL=navigation-location-service.js.map