"use strict";
// *****************************************************************************
// Copyright (C) 2022 Ericsson and others.
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
var HoverService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.HoverService = exports.HoverPosition = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("inversify");
const common_1 = require("../common");
const browser_1 = require("./browser");
const markdown_link_handler_1 = require("./markdown-rendering/markdown-link-handler");
const markdown_renderer_1 = require("./markdown-rendering/markdown-renderer");
const opener_service_1 = require("./opener-service");
require("../../src/browser/style/hover-service.css");
// Threshold, in milliseconds, over which a mouse movement is not considered
// quick enough as to be ignored
const quickMouseThresholdMillis = 200;
var HoverPosition;
(function (HoverPosition) {
    function invertIfNecessary(position, target, host, totalWidth, totalHeight) {
        if (position === 'left') {
            if (target.left - host.width - 5 < 0) {
                return 'right';
            }
        }
        else if (position === 'right') {
            if (target.right + host.width + 5 > totalWidth) {
                return 'left';
            }
        }
        else if (position === 'top') {
            if (target.top - host.height - 5 < 0) {
                return 'bottom';
            }
        }
        else if (position === 'bottom') {
            if (target.bottom + host.height + 5 > totalHeight) {
                return 'top';
            }
        }
        return position;
    }
    HoverPosition.invertIfNecessary = invertIfNecessary;
    /**
     * Tests whether a hover of the given dimensions fits next to its target in the given
     * position without extending beyond the window bounds.
     */
    function fits(position, target, host, totalWidth, totalHeight) {
        if (position === 'left') {
            return target.left - host.width - 5 >= 0;
        }
        else if (position === 'right') {
            return target.right + host.width + 5 <= totalWidth;
        }
        else if (position === 'top') {
            return target.top - host.height - 5 >= 0;
        }
        else {
            return target.bottom + host.height + 5 <= totalHeight;
        }
    }
    HoverPosition.fits = fits;
})(HoverPosition || (exports.HoverPosition = HoverPosition = {}));
let HoverService = class HoverService {
    constructor() {
        /** Identifies the latest render so that superseded renders can detect they are stale. */
        this.renderSequence = 0;
        this.lastHidHover = Date.now();
        this.disposeOnHide = new common_1.DisposableCollection();
    }
    static { HoverService_1 = this; }
    static { this.hostClassName = 'theia-hover'; }
    static { this.styleSheetId = 'theia-hover-style'; }
    /**
     * The host of the current hover, which may live in a secondary window's document.
     * Resolving against the main document here instead would silently replace the host
     * whenever the current hover lives in another document, detaching the dismissal
     * listeners and `unRenderHover` from the host that is actually rendered.
     */
    get hoverHost() {
        return this._hoverHost ?? this.getOrCreateHoverHost(document);
    }
    /**
     * Returns the host element to render hovers into for the given document, creating it if the
     * current one belongs to a different document. A host is always created in the document it is
     * shown in: adopting a host into another document would let it outlive its window, and touching
     * it after that window was closed breaks (and in Electron crashes) the application.
     */
    getOrCreateHoverHost(targetDocument) {
        if (!this._hoverHost || this._hoverHost.ownerDocument !== targetDocument) {
            this._hoverHost = targetDocument.createElement('div');
            this._hoverHost.classList.add(HoverService_1.hostClassName);
            this._hoverHost.style.position = 'absolute';
            this._hoverHost.setAttribute('popover', 'hint');
        }
        return this._hoverHost;
    }
    requestHover(request) {
        this.cancelHover();
        const targetWindow = request.target.ownerDocument.defaultView;
        if (!targetWindow || targetWindow.closed) {
            // the window hosting the target is already gone, e.g. a closed secondary window:
            // its document must not be touched anymore
            return;
        }
        const delay = request.skipHoverDelay ? 0 : this.getHoverDelay();
        this.pendingTimeout = (0, common_1.disposableTimeout)(() => this.renderHover(request), delay);
        this.hoverTarget = request.target;
        // resolve the host for the target's document up front so that the listeners below attach to the host that will be rendered
        this.getOrCreateHoverHost(request.target.ownerDocument);
        this.listenForWindowClose(request.target);
        this.listenForMouseOut();
        this.listenForMouseClick(request);
    }
    /**
     * Cancels the hover when the window hosting the target element goes away, e.g. when the
     * secondary window containing the target is closed: neither the hover host nor any listeners
     * may outlive the document they belong to.
     */
    listenForWindowClose(target) {
        const targetWindow = target.ownerDocument.defaultView;
        if (!targetWindow || targetWindow === window) {
            return;
        }
        const handlePageHide = () => this.cancelHover();
        targetWindow.addEventListener('pagehide', handlePageHide);
        this.disposeOnHide.push({ dispose: () => targetWindow.removeEventListener('pagehide', handlePageHide) });
    }
    getHoverDelay() {
        return Date.now() - this.lastHidHover < quickMouseThresholdMillis
            ? 0
            : this.preferences.get('workbench.hover.delay', common_1.isOSX ? 1500 : 500);
    }
    async renderHover(request) {
        const { target, content, position, cssClasses, interactive, onHide } = request;
        const targetWindow = target.ownerDocument.defaultView;
        if (!targetWindow || targetWindow.closed) {
            // the window hosting the target is already gone, e.g. a closed secondary window:
            // its document must not be touched anymore
            return;
        }
        const host = this.getOrCreateHoverHost(target.ownerDocument);
        const sequence = ++this.renderSequence;
        let firstChild;
        if (onHide) {
            this.disposeOnHide.push({ dispose: onHide.bind(request) });
        }
        if (cssClasses) {
            host.classList.add(...cssClasses);
        }
        if (content instanceof HTMLElement) {
            host.appendChild(content);
            firstChild = content;
        }
        else if (typeof content === 'string') {
            host.textContent = content;
        }
        else {
            const renderedContent = this.markdownRenderer.render(content);
            this.disposeOnHide.push(renderedContent);
            host.appendChild(renderedContent.element);
            firstChild = renderedContent.element;
            this.disposeOnHide.push((0, markdown_link_handler_1.wireMarkdownLinkHandler)(renderedContent.element, content, this.openerService));
        }
        // browsers might insert linebreaks when the hover appears at the edge of the window
        // resetting the position prevents that
        host.style.left = '0px';
        host.style.top = '0px';
        // Keep the host hidden while it is parked at (0,0) for measurement. A visible popover there
        // would, for a target in the upper-left of the viewport (e.g. a view docked in the left panel),
        // flash over the target for one frame. That steals the pointer from the target, whose mouse-leave
        // handler then cancels the hover, and the cycle repeats: the tooltip flickers and never settles.
        // `visibility: hidden` still lays the host out (so it can be measured) but is not hit-tested.
        host.style.visibility = 'hidden';
        // Render the hover in the document of the target: it may be hosted in a secondary window,
        // whose coordinate space is unrelated to the main window's.
        target.ownerDocument.body.append(host);
        if (!host.matches(':popover-open')) {
            host.showPopover();
        }
        if (interactive) {
            // Add a click handler to the hover host to ensure clicks within the hover area work properly
            const clickHandler = (e) => {
                // Let click events within the hover area be processed by their handlers
                // but prevent them from triggering document handlers that might dismiss the tooltip
                e.stopImmediatePropagation();
            };
            host.addEventListener('click', clickHandler);
            this.disposeOnHide.push({ dispose: () => host.removeEventListener('click', clickHandler) });
        }
        if (request.visualPreview) {
            // If just a string is being rendered use the size of the outer box
            const width = firstChild ? firstChild.offsetWidth : this.hoverHost.offsetWidth;
            const visualPreview = request.visualPreview(width);
            if (visualPreview) {
                host.appendChild(visualPreview);
            }
        }
        await this.hostAnimationFrame(target); // Allow the browser to size the host
        if (sequence !== this.renderSequence || !host.isConnected) {
            // this hover was cancelled or superseded by a newer one while waiting for the animation
            // frame: it must neither reposition nor reveal the host
            return;
        }
        const updatedPosition = this.setHostPosition(target, host, position);
        // Reveal the host only once it sits at its final position, so it never overlaps the target while
        // parked at (0,0). Dropping the declaration rather than assigning a value hands `visibility` back
        // to the stylesheet, which is where it comes from for every hover but the one being measured.
        host.style.removeProperty('visibility');
        this.disposeOnHide.push({
            dispose: () => {
                this.lastHidHover = Date.now();
                host.classList.remove(updatedPosition);
                if (cssClasses) {
                    host.classList.remove(...cssClasses);
                }
            }
        });
    }
    /**
     * Waits for an animation frame in the window hosting the given target element,
     * which may be a secondary window whose rendering is independent of the main window's.
     */
    hostAnimationFrame(target) {
        const targetWindow = target.ownerDocument.defaultView;
        if (!targetWindow || targetWindow === window) {
            return (0, browser_1.animationFrame)();
        }
        return new Promise(resolve => targetWindow.requestAnimationFrame(() => resolve()));
    }
    setHostPosition(target, host, position) {
        const hostDocument = target.ownerDocument;
        const targetDimensions = target.getBoundingClientRect();
        const hostDimensions = host.getBoundingClientRect();
        const documentWidth = hostDocument.body.getBoundingClientRect().width;
        // document.body.getBoundingClientRect().height doesn't work as expected
        // scrollHeight will always be accurate here: https://stackoverflow.com/a/44077777
        const documentHeight = hostDocument.documentElement.scrollHeight;
        position = HoverPosition.invertIfNecessary(position, targetDimensions, hostDimensions, documentWidth, documentHeight);
        if (!HoverPosition.fits(position, targetDimensions, hostDimensions, documentWidth, documentHeight)) {
            // The hover fits on neither side of the target in the requested direction, e.g. when the
            // target spans the full width of a narrow secondary window. Try the perpendicular direction
            // so that the target and the hover both remain visible. If that does not fit either,
            // keep the requested direction; the clamping below keeps the hover inside the viewport.
            const fallback = HoverPosition.invertIfNecessary(position === 'left' || position === 'right' ? 'bottom' : 'right', targetDimensions, hostDimensions, documentWidth, documentHeight);
            if (HoverPosition.fits(fallback, targetDimensions, hostDimensions, documentWidth, documentHeight)) {
                position = fallback;
            }
        }
        if (position === 'top' || position === 'bottom') {
            const targetMiddleWidth = targetDimensions.left + (targetDimensions.width / 2);
            const middleAlignment = targetMiddleWidth - (hostDimensions.width / 2);
            const furthestRight = Math.min(documentWidth - hostDimensions.width, middleAlignment);
            const left = Math.max(0, furthestRight);
            const top = position === 'top'
                ? targetDimensions.top - hostDimensions.height - 5
                : targetDimensions.bottom + 5;
            host.style.setProperty('--theia-hover-before-position', `${targetMiddleWidth - left - 5}px`);
            host.style.top = `${top}px`;
            host.style.left = `${left}px`;
        }
        else {
            const targetMiddleHeight = targetDimensions.top + (targetDimensions.height / 2);
            const middleAlignment = targetMiddleHeight - (hostDimensions.height / 2);
            const furthestTop = Math.min(documentHeight - hostDimensions.height, middleAlignment);
            const top = Math.max(0, furthestTop);
            const desiredLeft = position === 'left'
                ? targetDimensions.left - hostDimensions.width - 5
                : targetDimensions.right + 5;
            // the hover may not fit on either side of the target, e.g. when the target
            // spans the full width of a narrow (secondary) window: keep it in the viewport
            const furthestRight = Math.min(documentWidth - hostDimensions.width, desiredLeft);
            const left = Math.max(0, furthestRight);
            host.style.setProperty('--theia-hover-before-position', `${targetMiddleHeight - top - 5}px`);
            host.style.left = `${left}px`;
            host.style.top = `${top}px`;
        }
        host.classList.add(position);
        return position;
    }
    listenForMouseOut() {
        const handleMouseLeave = (e) => {
            this.disposeOnHide.push((0, common_1.disposableTimeout)(() => {
                if (!this.hoverHost.matches(':hover') && !this.hoverTarget?.matches(':hover')) {
                    this.cancelHover();
                }
            }, quickMouseThresholdMillis));
        };
        this.hoverTarget?.addEventListener('mouseout', handleMouseLeave);
        this.hoverHost.addEventListener('mouseout', handleMouseLeave);
        this.disposeOnHide.push({
            dispose: () => {
                this.hoverTarget?.removeEventListener('mouseout', handleMouseLeave);
                this.hoverHost.removeEventListener('mouseout', handleMouseLeave);
            }
        });
    }
    cancelHover() {
        this.pendingTimeout?.dispose();
        this.unRenderHover();
        this.disposeOnHide.dispose();
        this.hoverTarget = undefined;
    }
    /**
     * Listen for mouse click (mousedown) events and handle them based on hover interactivity.
     * For non-interactive hovers, any mousedown cancels the hover immediately.
     * For interactive hovers, the hover remains visible to allow interaction with its elements.
     */
    listenForMouseClick(request) {
        const handleMouseDown = (e) => {
            if (this.hoverHost.contains(e.target)) {
                return;
            }
            if (!request.interactive) {
                this.cancelHover();
            }
        };
        // Listen in the document of the target, which may be hosted in a secondary window
        const targetDocument = request.target.ownerDocument;
        targetDocument.addEventListener('mousedown', handleMouseDown, true);
        this.disposeOnHide.push({ dispose: () => targetDocument.removeEventListener('mousedown', handleMouseDown, true) });
    }
    unRenderHover() {
        const host = this._hoverHost;
        if (!host) {
            return;
        }
        const hostWindow = host.ownerDocument.defaultView;
        if (!hostWindow || hostWindow.closed) {
            // the window hosting the hover is already gone, e.g. a closed secondary window:
            // its DOM must not be touched anymore; abandon the host and start from scratch
            this._hoverHost = undefined;
            return;
        }
        try {
            if (host.matches(':popover-open')) {
                host.hidePopover();
            }
        }
        catch {
            // hidePopover throws for popovers in documents that are no longer fully active,
            // e.g. while the secondary window hosting the hover is being closed
        }
        host.remove();
        host.replaceChildren();
        // drop the classes added for the rendered hover (position and request classes): a render
        // aborted because it was superseded must not leak its classes into the next hover
        host.className = HoverService_1.hostClassName;
        // The host is reused across hovers; drop the transient hidden state set during measurement so a
        // hover cancelled before it was revealed does not leave the next one invisible.
        host.style.removeProperty('visibility');
        if (host.ownerDocument !== document) {
            // never keep a host from another document: it must not outlive its window
            this._hoverHost = undefined;
        }
    }
};
exports.HoverService = HoverService;
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.PreferenceService),
    tslib_1.__metadata("design:type", Object)
], HoverService.prototype, "preferences", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(markdown_renderer_1.CoreMarkdownRenderer),
    tslib_1.__metadata("design:type", Object)
], HoverService.prototype, "markdownRenderer", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(opener_service_1.OpenerService),
    tslib_1.__metadata("design:type", Object)
], HoverService.prototype, "openerService", void 0);
exports.HoverService = HoverService = HoverService_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], HoverService);
//# sourceMappingURL=hover-service.js.map