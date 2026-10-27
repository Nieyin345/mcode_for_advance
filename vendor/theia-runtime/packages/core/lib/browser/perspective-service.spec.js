"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource GmbH.
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
const jsdom_1 = require("./test/jsdom");
const disableJSDOM = (0, jsdom_1.enableJSDOM)();
const chai_1 = require("chai");
const sinon = require("sinon");
const perspective_service_1 = require("./perspective-service");
const view_contribution_1 = require("./shell/view-contribution");
const widgets_1 = require("@lumino/widgets");
disableJSDOM();
describe('PerspectiveService', () => {
    let service;
    let addWidgetStub;
    let activateWidgetStub;
    let getTabBarForStub;
    let getAreaForStub;
    let getOrCreateWidgetStub;
    let getLayoutDataStub;
    let setLayoutDataStub;
    let collapsePanelStub;
    let widgetAreaResolver;
    let tryGetWidgetStub;
    let getWidgetsStub;
    let mockLogger;
    let testWidget;
    let toTearDown;
    beforeEach(() => {
        toTearDown = (0, jsdom_1.enableJSDOM)();
        service = new perspective_service_1.PerspectiveServiceImpl();
        testWidget = new widgets_1.Widget();
        testWidget.id = 'test-widget';
        addWidgetStub = sinon.stub().resolves();
        activateWidgetStub = sinon.stub().resolves(undefined);
        getTabBarForStub = sinon.stub().returns(undefined);
        getAreaForStub = sinon.stub().returns(undefined);
        getOrCreateWidgetStub = sinon.stub().resolves(testWidget);
        getLayoutDataStub = sinon.stub().returns({ mainPanel: {}, bottomPanel: {} });
        setLayoutDataStub = sinon.stub().resolves();
        collapsePanelStub = sinon.stub().resolves();
        widgetAreaResolver = new perspective_service_1.WidgetAreaResolverImpl();
        getWidgetsStub = sinon.stub().returns([]);
        mockLogger = { debug: sinon.stub(), warn: sinon.stub() };
        const mockShell = {
            addWidget: addWidgetStub,
            activateWidget: activateWidgetStub,
            getTabBarFor: getTabBarForStub,
            getAreaFor: getAreaForStub,
            getLayoutData: getLayoutDataStub,
            setLayoutData: setLayoutDataStub,
            collapsePanel: collapsePanelStub,
            getWidgets: getWidgetsStub
        };
        tryGetWidgetStub = sinon.stub().returns(undefined);
        const mockWidgetManager = {
            getOrCreateWidget: getOrCreateWidgetStub,
            tryGetWidget: tryGetWidgetStub
        };
        // Assign mocks via property access since we can't use DI in tests
        service['shell'] = mockShell;
        service['widgetManager'] = mockWidgetManager;
        service['logger'] = mockLogger;
        service['widgetAreaResolver'] = widgetAreaResolver;
        service['appContributions'] = {
            getContributions: () => []
        };
    });
    afterEach(() => {
        sinon.restore();
        toTearDown();
    });
    it('should register a perspective', () => {
        const descriptor = {
            id: 'test',
            label: 'Test',
            viewPlacements: new Map([['widget-a', 'main']])
        };
        service.registerPerspective(descriptor);
        const perspectives = service.getRegisteredPerspectives();
        (0, chai_1.expect)(perspectives).to.have.lengthOf(1);
        (0, chai_1.expect)(perspectives[0].id).to.equal('test');
        (0, chai_1.expect)(perspectives[0].label).to.equal('Test');
    });
    it('should register multiple perspectives', () => {
        service.registerPerspective({
            id: 'perspective-1',
            label: 'Perspective 1',
            viewPlacements: new Map()
        });
        service.registerPerspective({
            id: 'perspective-2',
            label: 'Perspective 2',
            viewPlacements: new Map()
        });
        (0, chai_1.expect)(service.getRegisteredPerspectives()).to.have.lengthOf(2);
    });
    it('should return undefined for active perspective when none is set', () => {
        (0, chai_1.expect)(service.getActivePerspective()).to.be.undefined;
    });
    it('should return undefined from getAreaForView when no perspective is active', () => {
        service.registerPerspective({
            id: 'test',
            label: 'Test',
            viewPlacements: new Map([['widget-a', 'main']])
        });
        (0, chai_1.expect)(service.getAreaForView('widget-a')).to.be.undefined;
    });
    it('should return the override area when a perspective is active', async () => {
        service.registerPerspective({
            id: 'test',
            label: 'Test',
            viewPlacements: new Map([['widget-a', 'main']])
        });
        await service.switchPerspective('test');
        (0, chai_1.expect)(service.getAreaForView('widget-a')).to.equal('main');
    });
    it('should return undefined for views not in the perspective placement map', async () => {
        service.registerPerspective({
            id: 'test',
            label: 'Test',
            viewPlacements: new Map([['widget-a', 'main']])
        });
        await service.switchPerspective('test');
        (0, chai_1.expect)(service.getAreaForView('widget-b')).to.be.undefined;
    });
    it('should switch perspectives and update the active perspective', async () => {
        service.registerPerspective({
            id: 'first',
            label: 'First',
            viewPlacements: new Map()
        });
        service.registerPerspective({
            id: 'second',
            label: 'Second',
            viewPlacements: new Map()
        });
        await service.switchPerspective('first');
        (0, chai_1.expect)(service.getActivePerspective()?.id).to.equal('first');
        await service.switchPerspective('second');
        (0, chai_1.expect)(service.getActivePerspective()?.id).to.equal('second');
    });
    it('should fire onDidChangePerspective event when switching', async () => {
        service.registerPerspective({
            id: 'test',
            label: 'Test',
            viewPlacements: new Map()
        });
        const spy = sinon.spy();
        service.onDidChangePerspective(spy);
        await service.switchPerspective('test');
        (0, chai_1.expect)(spy.calledOnce).to.be.true;
        (0, chai_1.expect)(spy.calledWith('test')).to.be.true;
    });
    it('should not switch to a non-existent perspective', async () => {
        const spy = sinon.spy();
        service.onDidChangePerspective(spy);
        await service.switchPerspective('nonexistent');
        (0, chai_1.expect)(spy.called).to.be.false;
        (0, chai_1.expect)(service.getActivePerspective()).to.be.undefined;
    });
    it('should call onDeactivate on old perspective and onActivate on new perspective', async () => {
        const onDeactivate = sinon.spy();
        const onActivate = sinon.spy();
        service.registerPerspective({
            id: 'old',
            label: 'Old',
            viewPlacements: new Map(),
            onDeactivate
        });
        service.registerPerspective({
            id: 'new',
            label: 'New',
            viewPlacements: new Map(),
            onActivate
        });
        await service.switchPerspective('old');
        await service.switchPerspective('new');
        (0, chai_1.expect)(onDeactivate.calledOnce).to.be.true;
        (0, chai_1.expect)(onActivate.calledOnce).to.be.true;
        (0, chai_1.expect)(onDeactivate.calledBefore(onActivate)).to.be.true;
    });
    it('should add widgets to the target area during switch', async () => {
        service.registerPerspective({
            id: 'test',
            label: 'Test',
            viewPlacements: new Map([['test-widget', 'main']])
        });
        await service.switchPerspective('test');
        (0, chai_1.expect)(getOrCreateWidgetStub.calledWith('test-widget')).to.be.true;
        (0, chai_1.expect)(addWidgetStub.calledOnce).to.be.true;
        (0, chai_1.expect)(addWidgetStub.calledWith(testWidget, sinon.match({ area: 'main' }))).to.be.true;
    });
    it('should skip adding widget if already in the correct area', async () => {
        getTabBarForStub.returns({});
        getAreaForStub.returns('main');
        service.registerPerspective({
            id: 'test',
            label: 'Test',
            viewPlacements: new Map([['test-widget', 'main']])
        });
        await service.switchPerspective('test');
        (0, chai_1.expect)(addWidgetStub.called).to.be.false;
    });
    it('should call initialize and register contributions', () => {
        const mockContribution = {
            registerPerspectives: sinon.spy()
        };
        service['contributions'] = {
            getContributions: () => [mockContribution]
        };
        service.initialize();
        (0, chai_1.expect)(mockContribution.registerPerspectives.calledOnce).to.be.true;
        (0, chai_1.expect)(mockContribution.registerPerspectives.calledWith(service)).to.be.true;
    });
    it('should handle initialize with no contributions', () => {
        service['contributions'] = undefined;
        (0, chai_1.expect)(() => service.initialize()).to.not.throw();
    });
    // --- New tests for no-op guard, layout save/restore, and default perspective ---
    it('should register the default perspective on initialize', () => {
        service.initialize();
        const perspectives = service.getRegisteredPerspectives();
        const defaultPerspective = perspectives.find(p => p.id === perspective_service_1.PerspectiveServiceImpl.DEFAULT_PERSPECTIVE_ID);
        (0, chai_1.expect)(defaultPerspective).to.not.be.undefined;
        (0, chai_1.expect)(defaultPerspective.label).to.equal('Default');
        (0, chai_1.expect)(defaultPerspective.viewPlacements.size).to.equal(0);
    });
    it('should set the default perspective as the initial active perspective', () => {
        service.initialize();
        const active = service.getActivePerspective();
        (0, chai_1.expect)(active).to.not.be.undefined;
        (0, chai_1.expect)(active.id).to.equal(perspective_service_1.PerspectiveServiceImpl.DEFAULT_PERSPECTIVE_ID);
    });
    it('should not re-apply when switching to the already-active perspective', async () => {
        service.registerPerspective({
            id: 'test',
            label: 'Test',
            viewPlacements: new Map([['test-widget', 'main']]),
            onActivate: sinon.spy(),
            onDeactivate: sinon.spy()
        });
        await service.switchPerspective('test');
        // Reset all stubs
        addWidgetStub.resetHistory();
        setLayoutDataStub.resetHistory();
        getOrCreateWidgetStub.resetHistory();
        getLayoutDataStub.resetHistory();
        const eventSpy = sinon.spy();
        service.onDidChangePerspective(eventSpy);
        const descriptor = service.getActivePerspective();
        const onActivateSpy = descriptor.onActivate;
        const onDeactivateSpy = descriptor.onDeactivate;
        onActivateSpy.resetHistory();
        onDeactivateSpy.resetHistory();
        // Switch to the same perspective again
        await service.switchPerspective('test');
        (0, chai_1.expect)(addWidgetStub.called).to.be.false;
        (0, chai_1.expect)(setLayoutDataStub.called).to.be.false;
        (0, chai_1.expect)(getOrCreateWidgetStub.called).to.be.false;
        (0, chai_1.expect)(getLayoutDataStub.called).to.be.false;
        (0, chai_1.expect)(eventSpy.called).to.be.false;
        (0, chai_1.expect)(onActivateSpy.called).to.be.false;
        (0, chai_1.expect)(onDeactivateSpy.called).to.be.false;
    });
    it('should save layout when switching away from a perspective', async () => {
        service.registerPerspective({
            id: 'perspA',
            label: 'A',
            viewPlacements: new Map()
        });
        service.registerPerspective({
            id: 'perspB',
            label: 'B',
            viewPlacements: new Map()
        });
        await service.switchPerspective('perspA');
        const layoutA = { mainPanel: { widgets: ['editor1'] }, bottomPanel: {} };
        getLayoutDataStub.returns(layoutA);
        // Switch to B — should save A's layout
        await service.switchPerspective('perspB');
        (0, chai_1.expect)(getLayoutDataStub.called).to.be.true;
        const layoutB = { mainPanel: { widgets: ['something-else'] }, bottomPanel: {} };
        getLayoutDataStub.returns(layoutB);
        setLayoutDataStub.resetHistory();
        // Switch back to A — should restore A's saved layout
        await service.switchPerspective('perspA');
        (0, chai_1.expect)(setLayoutDataStub.calledOnce).to.be.true;
        (0, chai_1.expect)(setLayoutDataStub.calledWith(layoutA)).to.be.true;
    });
    it('should restore saved layout when switching back to a perspective', async () => {
        service.registerPerspective({
            id: 'perspA',
            label: 'A',
            viewPlacements: new Map([['test-widget', 'left']])
        });
        service.registerPerspective({
            id: 'perspB',
            label: 'B',
            viewPlacements: new Map()
        });
        // Activate A (first time — applies viewPlacements)
        await service.switchPerspective('perspA');
        const layoutA = { mainPanel: { widgets: ['editor-customized'] }, bottomPanel: {} };
        getLayoutDataStub.returns(layoutA);
        // Switch to B (saves A's layout)
        await service.switchPerspective('perspB');
        const layoutB = { mainPanel: { widgets: ['something-else'] }, bottomPanel: {} };
        getLayoutDataStub.returns(layoutB);
        setLayoutDataStub.resetHistory();
        getOrCreateWidgetStub.resetHistory();
        addWidgetStub.resetHistory();
        // Switch back to A — should restore saved layout, NOT apply viewPlacements
        await service.switchPerspective('perspA');
        (0, chai_1.expect)(setLayoutDataStub.calledOnce).to.be.true;
        (0, chai_1.expect)(setLayoutDataStub.calledWith(layoutA)).to.be.true;
        (0, chai_1.expect)(getOrCreateWidgetStub.called).to.be.false;
        (0, chai_1.expect)(addWidgetStub.called).to.be.false;
    });
    it('should apply viewPlacements on first activation (no saved layout)', async () => {
        service.registerPerspective({
            id: 'fresh',
            label: 'Fresh',
            viewPlacements: new Map([['test-widget', 'main']])
        });
        await service.switchPerspective('fresh');
        (0, chai_1.expect)(getOrCreateWidgetStub.calledWith('test-widget')).to.be.true;
        (0, chai_1.expect)(addWidgetStub.calledOnce).to.be.true;
        (0, chai_1.expect)(addWidgetStub.calledWith(testWidget, sinon.match({ area: 'main' }))).to.be.true;
        (0, chai_1.expect)(setLayoutDataStub.called).to.be.false;
    });
    it('should not apply viewPlacements when a saved layout exists', async () => {
        service.registerPerspective({
            id: 'perspA',
            label: 'A',
            viewPlacements: new Map([['test-widget', 'left']])
        });
        service.registerPerspective({
            id: 'perspB',
            label: 'B',
            viewPlacements: new Map()
        });
        // First activation of A — viewPlacements applied
        await service.switchPerspective('perspA');
        (0, chai_1.expect)(getOrCreateWidgetStub.called).to.be.true;
        // Switch to B (saves A's layout)
        await service.switchPerspective('perspB');
        getOrCreateWidgetStub.resetHistory();
        addWidgetStub.resetHistory();
        // Switch back to A — should restore layout, NOT use viewPlacements
        await service.switchPerspective('perspA');
        (0, chai_1.expect)(getOrCreateWidgetStub.called).to.be.false;
        (0, chai_1.expect)(addWidgetStub.called).to.be.false;
        (0, chai_1.expect)(setLayoutDataStub.called).to.be.true;
    });
    it('should allow full round-trip: default → custom → default', async () => {
        service.initialize();
        service.registerPerspective({
            id: 'ai-first',
            label: 'AI First',
            viewPlacements: new Map([['test-widget', 'left']])
        });
        // Start in default (set by initialize)
        (0, chai_1.expect)(service.getActivePerspective()?.id).to.equal(perspective_service_1.PerspectiveServiceImpl.DEFAULT_PERSPECTIVE_ID);
        const defaultLayout = { mainPanel: { widgets: ['default-editor'] }, bottomPanel: {} };
        getLayoutDataStub.returns(defaultLayout);
        // Switch to ai-first (saves default layout)
        await service.switchPerspective('ai-first');
        (0, chai_1.expect)(service.getActivePerspective()?.id).to.equal('ai-first');
        (0, chai_1.expect)(getLayoutDataStub.called).to.be.true;
        (0, chai_1.expect)(getOrCreateWidgetStub.calledWith('test-widget')).to.be.true;
        const aiLayout = { mainPanel: { widgets: ['ai-stuff'] }, bottomPanel: {} };
        getLayoutDataStub.returns(aiLayout);
        setLayoutDataStub.resetHistory();
        // Switch back to default (saves ai-first layout, restores default layout)
        await service.switchPerspective(perspective_service_1.PerspectiveServiceImpl.DEFAULT_PERSPECTIVE_ID);
        (0, chai_1.expect)(service.getActivePerspective()?.id).to.equal(perspective_service_1.PerspectiveServiceImpl.DEFAULT_PERSPECTIVE_ID);
        (0, chai_1.expect)(setLayoutDataStub.calledOnce).to.be.true;
        (0, chai_1.expect)(setLayoutDataStub.calledWith(defaultLayout)).to.be.true;
        setLayoutDataStub.resetHistory();
        // Switch back to ai-first (saves default layout again, restores ai-first layout)
        await service.switchPerspective('ai-first');
        (0, chai_1.expect)(service.getActivePerspective()?.id).to.equal('ai-first');
        (0, chai_1.expect)(setLayoutDataStub.calledOnce).to.be.true;
        (0, chai_1.expect)(setLayoutDataStub.calledWith(aiLayout)).to.be.true;
    });
    // --- Chrome control options tests ---
    it('should collapse areas on first activation only', async () => {
        service.registerPerspective({
            id: 'collapse-test',
            label: 'Collapse Test',
            viewPlacements: new Map(),
            chromeOptions: { collapseAreas: ['left'] }
        });
        service.registerPerspective({
            id: 'other',
            label: 'Other',
            viewPlacements: new Map()
        });
        // First activation — should collapse
        await service.switchPerspective('collapse-test');
        (0, chai_1.expect)(collapsePanelStub.calledOnce).to.be.true;
        (0, chai_1.expect)(collapsePanelStub.calledWith('left')).to.be.true;
        collapsePanelStub.resetHistory();
        // Switch away (saves layout)
        await service.switchPerspective('other');
        collapsePanelStub.resetHistory();
        // Switch back — should restore saved layout, NOT collapse again
        await service.switchPerspective('collapse-test');
        (0, chai_1.expect)(collapsePanelStub.called).to.be.false;
    });
    it('should collapse multiple areas on first activation', async () => {
        service.registerPerspective({
            id: 'multi-collapse',
            label: 'Multi Collapse',
            viewPlacements: new Map(),
            chromeOptions: { collapseAreas: ['left', 'bottom'] }
        });
        await service.switchPerspective('multi-collapse');
        (0, chai_1.expect)(collapsePanelStub.calledTwice).to.be.true;
        (0, chai_1.expect)(collapsePanelStub.calledWith('left')).to.be.true;
        (0, chai_1.expect)(collapsePanelStub.calledWith('bottom')).to.be.true;
    });
    it('should not collapse areas when perspective has no collapseAreas', async () => {
        service.registerPerspective({
            id: 'no-collapse',
            label: 'No Collapse',
            viewPlacements: new Map()
        });
        await service.switchPerspective('no-collapse');
        (0, chai_1.expect)(collapsePanelStub.called).to.be.false;
    });
    // --- WidgetAreaResolver tests ---
    it('should resolve widget area from active perspective via the WidgetAreaResolver', async () => {
        service.initialize();
        service.registerPerspective({
            id: 'resolver-test',
            label: 'Resolver Test',
            viewPlacements: new Map([['my-widget', 'right']])
        });
        await service.switchPerspective('resolver-test');
        (0, chai_1.expect)(widgetAreaResolver.resolveArea('my-widget', 'left')).to.equal('right');
    });
    it('should return undefined from the resolver for unmapped widgets', async () => {
        service.initialize();
        service.registerPerspective({
            id: 'resolver-test',
            label: 'Resolver Test',
            viewPlacements: new Map([['my-widget', 'right']])
        });
        await service.switchPerspective('resolver-test');
        (0, chai_1.expect)(widgetAreaResolver.resolveArea('unknown-widget', 'main')).to.be.undefined;
    });
    it('should return undefined from the resolver when default perspective is active', () => {
        service.initialize();
        // Default perspective has empty viewPlacements
        (0, chai_1.expect)(widgetAreaResolver.resolveArea('any-widget', 'main')).to.be.undefined;
    });
    // --- Logger tests ---
    it('should log warning when widget creation fails during switchPerspective', async () => {
        const widgetError = new Error('No factory registered');
        getOrCreateWidgetStub.rejects(widgetError);
        service.registerPerspective({
            id: 'fail-test',
            label: 'Fail Test',
            viewPlacements: new Map([['missing-widget', 'main']])
        });
        await service.switchPerspective('fail-test');
        (0, chai_1.expect)(mockLogger.warn.calledOnce).to.be.true;
        (0, chai_1.expect)(mockLogger.warn.firstCall.args[0]).to.equal('Failed to create or place widget for perspective');
        (0, chai_1.expect)(mockLogger.warn.firstCall.args[1]).to.equal(widgetError);
    });
    it('should log warning when widget activation fails during switchPerspective', async () => {
        const activationError = new Error('Activation failed');
        activateWidgetStub.rejects(activationError);
        service.registerPerspective({
            id: 'activate-fail',
            label: 'Activate Fail',
            viewPlacements: new Map([['test-widget', 'main']])
        });
        await service.switchPerspective('activate-fail');
        (0, chai_1.expect)(mockLogger.warn.called).to.be.true;
        const activateCall = mockLogger.warn.getCalls().find((c) => c.args[0] === 'Failed to activate widget for perspective');
        (0, chai_1.expect)(activateCall).to.not.be.undefined;
        (0, chai_1.expect)(activateCall.args[1]).to.equal(activationError);
    });
    // --- Reentrancy guard tests ---
    it('should handle two rapid switchPerspective calls without interleaving', async () => {
        service.registerPerspective({
            id: 'first',
            label: 'First',
            viewPlacements: new Map()
        });
        service.registerPerspective({
            id: 'second',
            label: 'Second',
            viewPlacements: new Map()
        });
        const promise1 = service.switchPerspective('first');
        const promise2 = service.switchPerspective('second');
        await Promise.all([promise1, promise2]);
        (0, chai_1.expect)(service.getActivePerspective()?.id).to.equal('second');
    });
    it('should serialize perspective switches with reentrancy guard', async () => {
        const callOrder = [];
        service.registerPerspective({
            id: 'perspA',
            label: 'A',
            viewPlacements: new Map(),
            onActivate: () => callOrder.push('activate-A')
        });
        service.registerPerspective({
            id: 'perspB',
            label: 'B',
            viewPlacements: new Map(),
            onActivate: () => callOrder.push('activate-B')
        });
        const p1 = service.switchPerspective('perspA');
        const p2 = service.switchPerspective('perspB');
        await Promise.all([p1, p2]);
        (0, chai_1.expect)(callOrder).to.deep.equal(['activate-A', 'activate-B']);
        (0, chai_1.expect)(service.getActivePerspective()?.id).to.equal('perspB');
    });
    it('should serialize three or more concurrent perspective switches', async () => {
        const callOrder = [];
        service.registerPerspective({
            id: 'perspA',
            label: 'A',
            viewPlacements: new Map(),
            onActivate: () => callOrder.push('activate-A')
        });
        service.registerPerspective({
            id: 'perspB',
            label: 'B',
            viewPlacements: new Map(),
            onActivate: () => callOrder.push('activate-B')
        });
        service.registerPerspective({
            id: 'perspC',
            label: 'C',
            viewPlacements: new Map(),
            onActivate: () => callOrder.push('activate-C')
        });
        const p1 = service.switchPerspective('perspA');
        const p2 = service.switchPerspective('perspB');
        const p3 = service.switchPerspective('perspC');
        await Promise.all([p1, p2, p3]);
        (0, chai_1.expect)(callOrder).to.deep.equal(['activate-A', 'activate-B', 'activate-C']);
        (0, chai_1.expect)(service.getActivePerspective()?.id).to.equal('perspC');
    });
    // --- onLayoutRestored() tests ---
    it('should not throw when onLayoutRestored is called with an unregistered perspective', () => {
        service.initialize();
        (0, chai_1.expect)(() => service.onLayoutRestored('non-existent')).to.not.throw();
    });
    // --- Rejection resilience tests ---
    it('should warn and continue when setLayoutData rejects during saved layout restore', async () => {
        service.registerPerspective({
            id: 'perspA',
            label: 'A',
            viewPlacements: new Map()
        });
        service.registerPerspective({
            id: 'perspB',
            label: 'B',
            viewPlacements: new Map()
        });
        // Switch to A, then to B (saves A's layout)
        await service.switchPerspective('perspA');
        await service.switchPerspective('perspB');
        // Make setLayoutData reject
        setLayoutDataStub.rejects(new Error('layout error'));
        const eventSpy = sinon.spy();
        service.onDidChangePerspective(eventSpy);
        // Switch back to A — should not throw
        await service.switchPerspective('perspA');
        (0, chai_1.expect)(service.getActivePerspective()?.id).to.equal('perspA');
        (0, chai_1.expect)(eventSpy.calledOnce).to.be.true;
        (0, chai_1.expect)(eventSpy.calledWith('perspA')).to.be.true;
        (0, chai_1.expect)(mockLogger.warn.calledOnce).to.be.true;
        (0, chai_1.expect)(mockLogger.warn.firstCall.args[0]).to.equal('Failed to apply layout for perspective');
    });
    it('should warn and continue when collapsePanel rejects on first activation', async () => {
        service.registerPerspective({
            id: 'collapse-fail',
            label: 'Collapse Fail',
            viewPlacements: new Map(),
            chromeOptions: { collapseAreas: ['left'] }
        });
        collapsePanelStub.rejects(new Error('collapse error'));
        const eventSpy = sinon.spy();
        service.onDidChangePerspective(eventSpy);
        // Switch — should not throw
        await service.switchPerspective('collapse-fail');
        (0, chai_1.expect)(service.getActivePerspective()?.id).to.equal('collapse-fail');
        (0, chai_1.expect)(eventSpy.calledOnce).to.be.true;
        (0, chai_1.expect)(mockLogger.warn.calledOnce).to.be.true;
        (0, chai_1.expect)(mockLogger.warn.firstCall.args[0]).to.equal('Failed to apply layout for perspective');
    });
    it('should not drop queued switches when layout application fails', async () => {
        service.registerPerspective({
            id: 'perspA',
            label: 'A',
            viewPlacements: new Map()
        });
        service.registerPerspective({
            id: 'perspB',
            label: 'B',
            viewPlacements: new Map()
        });
        service.registerPerspective({
            id: 'perspC',
            label: 'C',
            viewPlacements: new Map()
        });
        // Switch to A, then to B (saves A's layout)
        await service.switchPerspective('perspA');
        await service.switchPerspective('perspB');
        // Make setLayoutData reject only on first call, then resolve
        setLayoutDataStub.resetBehavior();
        setLayoutDataStub.onFirstCall().rejects(new Error('layout error'));
        setLayoutDataStub.onSecondCall().resolves();
        // Queue: switch to A (will fail layout restore), then switch to C
        const p1 = service.switchPerspective('perspA');
        const p2 = service.switchPerspective('perspC');
        await Promise.all([p1, p2]);
        (0, chai_1.expect)(service.getActivePerspective()?.id).to.equal('perspC');
    });
    // --- resetCurrentPerspective tests ---
    describe('resetCurrentPerspective', () => {
        it('should clear saved layout and re-apply viewPlacements on reset for non-default perspective', async () => {
            service.registerPerspective({
                id: 'perspA',
                label: 'A',
                viewPlacements: new Map([['test-widget', 'left']])
            });
            service.registerPerspective({
                id: 'perspB',
                label: 'B',
                viewPlacements: new Map()
            });
            await service.switchPerspective('perspA');
            const layoutA = { mainPanel: { widgets: ['customized'] }, bottomPanel: {} };
            getLayoutDataStub.returns(layoutA);
            // Switch to B (saves A's layout)
            await service.switchPerspective('perspB');
            // Switch back to A (restores saved layout)
            await service.switchPerspective('perspA');
            // Verify saved layout exists
            (0, chai_1.expect)(service.getSavedLayout('perspA')).to.not.be.undefined;
            // Reset stubs to track reset behavior
            setLayoutDataStub.resetHistory();
            getOrCreateWidgetStub.resetHistory();
            addWidgetStub.resetHistory();
            activateWidgetStub.resetHistory();
            await service.resetCurrentPerspective();
            // Saved layout should be cleared
            (0, chai_1.expect)(service.getSavedLayout('perspA')).to.be.undefined;
            // Should re-apply viewPlacements
            (0, chai_1.expect)(getOrCreateWidgetStub.calledWith('test-widget')).to.be.true;
            (0, chai_1.expect)(addWidgetStub.called).to.be.true;
        });
        it('should call onActivate callback', async () => {
            const onActivate = sinon.spy();
            service.registerPerspective({
                id: 'activate-reset',
                label: 'Activate Reset',
                viewPlacements: new Map(),
                onActivate
            });
            await service.switchPerspective('activate-reset');
            onActivate.resetHistory();
            await service.resetCurrentPerspective();
            (0, chai_1.expect)(onActivate.calledOnce).to.be.true;
        });
        it('should fire onDidChangePerspective event', async () => {
            service.registerPerspective({
                id: 'event-reset',
                label: 'Event Reset',
                viewPlacements: new Map()
            });
            await service.switchPerspective('event-reset');
            const spy = sinon.spy();
            service.onDidChangePerspective(spy);
            await service.resetCurrentPerspective();
            (0, chai_1.expect)(spy.calledOnce).to.be.true;
            (0, chai_1.expect)(spy.calledWith('event-reset')).to.be.true;
        });
        it('should not affect other perspectives\' saved layouts', async () => {
            service.registerPerspective({
                id: 'perspA',
                label: 'A',
                viewPlacements: new Map()
            });
            service.registerPerspective({
                id: 'perspB',
                label: 'B',
                viewPlacements: new Map()
            });
            // Activate A, then B, to create saved layouts for both
            await service.switchPerspective('perspA');
            const layoutA = { mainPanel: { widgets: ['a-stuff'] }, bottomPanel: {} };
            getLayoutDataStub.returns(layoutA);
            await service.switchPerspective('perspB');
            const layoutB = { mainPanel: { widgets: ['b-stuff'] }, bottomPanel: {} };
            getLayoutDataStub.returns(layoutB);
            // Switch back to A (saves B's layout)
            await service.switchPerspective('perspA');
            // Reset A
            await service.resetCurrentPerspective();
            // A's saved layout should be cleared
            (0, chai_1.expect)(service.getSavedLayout('perspA')).to.be.undefined;
            // B's saved layout should be preserved
            (0, chai_1.expect)(service.getSavedLayout('perspB')).to.equal(layoutB);
        });
        it('should serialize with other switchPerspective calls', async () => {
            const callOrder = [];
            service.registerPerspective({
                id: 'perspA',
                label: 'A',
                viewPlacements: new Map(),
                onActivate: () => callOrder.push('activate-A')
            });
            service.registerPerspective({
                id: 'perspB',
                label: 'B',
                viewPlacements: new Map(),
                onActivate: () => callOrder.push('activate-B')
            });
            await service.switchPerspective('perspA');
            callOrder.length = 0;
            // Queue a reset and a switch concurrently
            const p1 = service.resetCurrentPerspective();
            const p2 = service.switchPerspective('perspB');
            await Promise.all([p1, p2]);
            (0, chai_1.expect)(callOrder).to.deep.equal(['activate-A', 'activate-B']);
            (0, chai_1.expect)(service.getActivePerspective()?.id).to.equal('perspB');
        });
        it('should do nothing when no active perspective is set', async () => {
            // No perspective active (activePerspectiveId is undefined)
            const spy = sinon.spy();
            service.onDidChangePerspective(spy);
            await service.resetCurrentPerspective();
            (0, chai_1.expect)(spy.called).to.be.false;
            (0, chai_1.expect)(getOrCreateWidgetStub.called).to.be.false;
        });
    });
    describe('resetDefaultPerspective', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        function createMockViewContribution(options) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const contribution = Object.create(view_contribution_1.AbstractViewContribution.prototype);
            contribution.options = options;
            contribution.widgetManager = {
                getOrCreateWidget: getOrCreateWidgetStub,
                tryGetWidget: tryGetWidgetStub
            };
            contribution.shell = service['shell'];
            contribution.openView = sinon.stub().resolves(testWidget);
            return contribution;
        }
        function createMockNonViewContribution() {
            const contrib = {};
            return contrib;
        }
        it('should relocate open view from wrong area to defaultViewOptions.area', async () => {
            service.initialize();
            const explorerWidget = new widgets_1.Widget();
            explorerWidget.id = 'explorer';
            const explorerPanel = new widgets_1.Panel();
            widgets_1.Widget.attach(explorerPanel, document.body);
            explorerPanel.addWidget(explorerWidget);
            tryGetWidgetStub.withArgs('explorer').returns(explorerWidget);
            getAreaForStub.withArgs(explorerWidget).returns('right');
            const contribution = createMockViewContribution({
                widgetId: 'explorer',
                widgetName: 'Explorer',
                defaultWidgetOptions: { area: 'left' }
            });
            service['appContributions'] = {
                getContributions: () => [contribution]
            };
            await service.resetCurrentPerspective();
            (0, chai_1.expect)(addWidgetStub.calledWith(explorerWidget, sinon.match({ area: 'left' }))).to.be.true;
            explorerPanel.dispose();
        });
        it('should skip views already in correct area', async () => {
            service.initialize();
            const explorerWidget = new widgets_1.Widget();
            explorerWidget.id = 'explorer';
            const explorerPanel = new widgets_1.Panel();
            widgets_1.Widget.attach(explorerPanel, document.body);
            explorerPanel.addWidget(explorerWidget);
            tryGetWidgetStub.withArgs('explorer').returns(explorerWidget);
            getAreaForStub.withArgs(explorerWidget).returns('left');
            const contribution = createMockViewContribution({
                widgetId: 'explorer',
                widgetName: 'Explorer',
                defaultWidgetOptions: { area: 'left' }
            });
            service['appContributions'] = {
                getContributions: () => [contribution]
            };
            addWidgetStub.resetHistory();
            await service.resetCurrentPerspective();
            (0, chai_1.expect)(addWidgetStub.called).to.be.false;
            explorerPanel.dispose();
        });
        it('should skip views not attached', async () => {
            service.initialize();
            const explorerWidget = new widgets_1.Widget();
            explorerWidget.id = 'explorer';
            // Not attached to any parent
            tryGetWidgetStub.withArgs('explorer').returns(explorerWidget);
            const contribution = createMockViewContribution({
                widgetId: 'explorer',
                widgetName: 'Explorer',
                defaultWidgetOptions: { area: 'left' }
            });
            service['appContributions'] = {
                getContributions: () => [contribution]
            };
            addWidgetStub.resetHistory();
            await service.resetCurrentPerspective();
            // Phase 1 should not try to relocate (not attached)
            // Phase 2 will call initializeLayout
            (0, chai_1.expect)(addWidgetStub.called).to.be.false;
        });
        it('should call openView on AbstractViewContribution instances', async () => {
            service.initialize();
            const contribution = createMockViewContribution({
                widgetId: 'explorer',
                widgetName: 'Explorer',
                defaultWidgetOptions: { area: 'left' }
            });
            service['appContributions'] = {
                getContributions: () => [contribution]
            };
            await service.resetCurrentPerspective();
            (0, chai_1.expect)(contribution.openView.calledOnce).to.be.true;
            (0, chai_1.expect)(contribution.openView.calledWith({ activate: false })).to.be.true;
        });
        it('should NOT call openView on non-AbstractViewContribution contributions', async () => {
            service.initialize();
            const nonViewContrib = createMockNonViewContribution();
            service['appContributions'] = {
                getContributions: () => [nonViewContrib]
            };
            // Should not throw
            await service.resetCurrentPerspective();
        });
        it('should handle combined scenario: open view in wrong area + closed view', async () => {
            service.initialize();
            // Explorer is open but in the wrong area
            const explorerWidget = new widgets_1.Widget();
            explorerWidget.id = 'explorer';
            const panel = new widgets_1.Panel();
            widgets_1.Widget.attach(panel, document.body);
            panel.addWidget(explorerWidget);
            tryGetWidgetStub.withArgs('explorer').returns(explorerWidget);
            getAreaForStub.withArgs(explorerWidget).returns('right');
            const explorerContrib = createMockViewContribution({
                widgetId: 'explorer',
                widgetName: 'Explorer',
                defaultWidgetOptions: { area: 'left' }
            });
            // SCM is closed (tryGetWidget returns undefined)
            tryGetWidgetStub.withArgs('scm').returns(undefined);
            const scmContrib = createMockViewContribution({
                widgetId: 'scm',
                widgetName: 'SCM',
                defaultWidgetOptions: { area: 'left' }
            });
            service['appContributions'] = {
                getContributions: () => [explorerContrib, scmContrib]
            };
            addWidgetStub.resetHistory();
            await service.resetCurrentPerspective();
            // Phase 1: Explorer should be relocated
            (0, chai_1.expect)(addWidgetStub.calledWith(explorerWidget, sinon.match({ area: 'left' }))).to.be.true;
            // Phase 2: Both should have openView called
            (0, chai_1.expect)(explorerContrib.openView.calledOnce).to.be.true;
            (0, chai_1.expect)(scmContrib.openView.calledOnce).to.be.true;
            panel.dispose();
        });
        it('should use viewContainerId as effectiveWidgetId when set', async () => {
            service.initialize();
            const containerWidget = new widgets_1.Widget();
            containerWidget.id = 'explorer-container';
            const panel = new widgets_1.Panel();
            widgets_1.Widget.attach(panel, document.body);
            panel.addWidget(containerWidget);
            tryGetWidgetStub.withArgs('explorer-container').returns(containerWidget);
            getAreaForStub.withArgs(containerWidget).returns('right');
            const contribution = createMockViewContribution({
                widgetId: 'explorer',
                viewContainerId: 'explorer-container',
                widgetName: 'Explorer',
                defaultWidgetOptions: { area: 'left' }
            });
            service['appContributions'] = {
                getContributions: () => [contribution]
            };
            addWidgetStub.resetHistory();
            await service.resetCurrentPerspective();
            (0, chai_1.expect)(tryGetWidgetStub.calledWith('explorer-container')).to.be.true;
            (0, chai_1.expect)(addWidgetStub.calledWith(containerWidget, sinon.match({ area: 'left' }))).to.be.true;
            panel.dispose();
        });
        it('should handle openView errors gracefully', async () => {
            service.initialize();
            const contribution = createMockViewContribution({
                widgetId: 'broken',
                widgetName: 'Broken',
                defaultWidgetOptions: { area: 'left' }
            });
            contribution.openView.rejects(new Error('openView failed'));
            service['appContributions'] = {
                getContributions: () => [contribution]
            };
            // Should not throw
            await service.resetCurrentPerspective();
            (0, chai_1.expect)(mockLogger.warn.called).to.be.true;
        });
        it('should handle widget relocation errors gracefully', async () => {
            service.initialize();
            const explorerWidget = new widgets_1.Widget();
            explorerWidget.id = 'explorer';
            const panel = new widgets_1.Panel();
            widgets_1.Widget.attach(panel, document.body);
            panel.addWidget(explorerWidget);
            tryGetWidgetStub.withArgs('explorer').returns(explorerWidget);
            getAreaForStub.withArgs(explorerWidget).returns('right');
            addWidgetStub.rejects(new Error('relocation failed'));
            const contribution = createMockViewContribution({
                widgetId: 'explorer',
                widgetName: 'Explorer',
                defaultWidgetOptions: { area: 'left' }
            });
            service['appContributions'] = {
                getContributions: () => [contribution]
            };
            // Should not throw
            await service.resetCurrentPerspective();
            (0, chai_1.expect)(mockLogger.warn.called).to.be.true;
            panel.dispose();
        });
        it('should fire onDidChangePerspective event on default perspective reset', async () => {
            service.initialize();
            service['appContributions'] = {
                getContributions: () => []
            };
            const spy = sinon.spy();
            service.onDidChangePerspective(spy);
            await service.resetCurrentPerspective();
            (0, chai_1.expect)(spy.calledOnce).to.be.true;
            (0, chai_1.expect)(spy.calledWith(perspective_service_1.PerspectiveServiceImpl.DEFAULT_PERSPECTIVE_ID)).to.be.true;
        });
        it('should skip contributions without defaultViewOptions.area in Phase 1', async () => {
            service.initialize();
            const contribution = createMockViewContribution({
                widgetId: 'no-area',
                widgetName: 'No Area',
                defaultWidgetOptions: {}
            });
            service['appContributions'] = {
                getContributions: () => [contribution]
            };
            addWidgetStub.resetHistory();
            await service.resetCurrentPerspective();
            // Phase 1 should skip (no target area)
            // Phase 2 should still call openView
            (0, chai_1.expect)(contribution.openView.calledOnce).to.be.true;
        });
    });
    describe('layout healing on perspective switch', () => {
        it('should replace disposed side panel widget when switching back to a perspective', async () => {
            service.registerPerspective({
                id: 'perspA',
                label: 'A',
                viewPlacements: new Map()
            });
            service.registerPerspective({
                id: 'perspB',
                label: 'B',
                viewPlacements: new Map()
            });
            // Create a widget and then dispose it to simulate cross-perspective closure
            const disposedWidget = new widgets_1.Widget();
            disposedWidget.id = 'explorer-widget';
            disposedWidget.dispose();
            (0, chai_1.expect)(disposedWidget.isDisposed).to.be.true;
            const freshWidget = new widgets_1.Widget();
            freshWidget.id = 'explorer-widget';
            getOrCreateWidgetStub.withArgs('explorer-widget').resolves(freshWidget);
            const savedLayout = {
                leftPanel: {
                    type: 'sidepanel',
                    items: [{ widget: disposedWidget, rank: 0, expanded: true }]
                },
                mainPanel: undefined,
                bottomPanel: undefined
            };
            // Switch to A, then to B
            await service.switchPerspective('perspA');
            await service.switchPerspective('perspB');
            // Manually set the saved layout for A with the disposed widget
            service.setSavedLayout('perspA', savedLayout);
            setLayoutDataStub.resetHistory();
            getOrCreateWidgetStub.resetHistory();
            // Switch back to A
            await service.switchPerspective('perspA');
            (0, chai_1.expect)(getOrCreateWidgetStub.calledWith('explorer-widget')).to.be.true;
            (0, chai_1.expect)(setLayoutDataStub.calledOnce).to.be.true;
            // The layout should now contain the fresh widget
            const restoredLayout = setLayoutDataStub.firstCall.args[0];
            (0, chai_1.expect)(restoredLayout.leftPanel.items[0].widget).to.equal(freshWidget);
        });
        it('should replace disposed dock panel widget (main area)', async () => {
            service.registerPerspective({
                id: 'perspA',
                label: 'A',
                viewPlacements: new Map()
            });
            service.registerPerspective({
                id: 'perspB',
                label: 'B',
                viewPlacements: new Map()
            });
            const disposedWidget = new widgets_1.Widget();
            disposedWidget.id = 'editor-widget';
            disposedWidget.dispose();
            const freshWidget = new widgets_1.Widget();
            freshWidget.id = 'editor-widget';
            getOrCreateWidgetStub.withArgs('editor-widget').resolves(freshWidget);
            const savedLayout = {
                mainPanel: {
                    main: {
                        type: 'tab-area',
                        widgets: [disposedWidget],
                        currentIndex: 0
                    }
                },
                bottomPanel: undefined
            };
            await service.switchPerspective('perspA');
            await service.switchPerspective('perspB');
            service.setSavedLayout('perspA', savedLayout);
            setLayoutDataStub.resetHistory();
            getOrCreateWidgetStub.resetHistory();
            await service.switchPerspective('perspA');
            (0, chai_1.expect)(getOrCreateWidgetStub.calledWith('editor-widget')).to.be.true;
            const restoredLayout = setLayoutDataStub.firstCall.args[0];
            (0, chai_1.expect)(restoredLayout.mainPanel.main.widgets[0]).to.equal(freshWidget);
        });
        it('should handle recreation failure gracefully', async () => {
            service.registerPerspective({
                id: 'perspA',
                label: 'A',
                viewPlacements: new Map()
            });
            service.registerPerspective({
                id: 'perspB',
                label: 'B',
                viewPlacements: new Map()
            });
            const disposedWidget = new widgets_1.Widget();
            disposedWidget.id = 'broken-widget';
            disposedWidget.dispose();
            getOrCreateWidgetStub.withArgs('broken-widget').rejects(new Error('No factory'));
            const savedLayout = {
                leftPanel: {
                    type: 'sidepanel',
                    items: [{ widget: disposedWidget, rank: 0, expanded: true }]
                },
                mainPanel: undefined,
                bottomPanel: undefined
            };
            await service.switchPerspective('perspA');
            await service.switchPerspective('perspB');
            service.setSavedLayout('perspA', savedLayout);
            mockLogger.warn.resetHistory();
            setLayoutDataStub.resetHistory();
            await service.switchPerspective('perspA');
            // Widget should be set to undefined in the layout
            const restoredLayout = setLayoutDataStub.firstCall.args[0];
            (0, chai_1.expect)(restoredLayout.leftPanel.items[0].widget).to.be.undefined;
            // Warn log should have been called
            (0, chai_1.expect)(mockLogger.warn.called).to.be.true;
            const healCall = mockLogger.warn.getCalls().find((c) => c.args[0] === 'Failed to recreate disposed widget for perspective layout');
            (0, chai_1.expect)(healCall).to.not.be.undefined;
            // setLayoutData should still be called
            (0, chai_1.expect)(setLayoutDataStub.calledOnce).to.be.true;
        });
        it('should handle recreation failure in dock panel by splicing widget', async () => {
            service.registerPerspective({
                id: 'perspA',
                label: 'A',
                viewPlacements: new Map()
            });
            service.registerPerspective({
                id: 'perspB',
                label: 'B',
                viewPlacements: new Map()
            });
            const disposedWidget = new widgets_1.Widget();
            disposedWidget.id = 'broken-widget';
            disposedWidget.dispose();
            const goodWidget = new widgets_1.Widget();
            goodWidget.id = 'good-widget';
            getOrCreateWidgetStub.withArgs('broken-widget').rejects(new Error('No factory'));
            const savedLayout = {
                mainPanel: {
                    main: {
                        type: 'tab-area',
                        widgets: [goodWidget, disposedWidget],
                        currentIndex: 0
                    }
                },
                bottomPanel: undefined
            };
            await service.switchPerspective('perspA');
            await service.switchPerspective('perspB');
            service.setSavedLayout('perspA', savedLayout);
            setLayoutDataStub.resetHistory();
            await service.switchPerspective('perspA');
            const restoredLayout = setLayoutDataStub.firstCall.args[0];
            const tabArea = restoredLayout.mainPanel.main;
            // The broken widget should have been spliced out
            (0, chai_1.expect)(tabArea.widgets).to.have.lengthOf(1);
            (0, chai_1.expect)(tabArea.widgets[0]).to.equal(goodWidget);
        });
        it('should not touch non-disposed widgets', async () => {
            service.registerPerspective({
                id: 'perspA',
                label: 'A',
                viewPlacements: new Map()
            });
            service.registerPerspective({
                id: 'perspB',
                label: 'B',
                viewPlacements: new Map()
            });
            const liveWidget = new widgets_1.Widget();
            liveWidget.id = 'live-widget';
            const disposedWidget = new widgets_1.Widget();
            disposedWidget.id = 'dead-widget';
            disposedWidget.dispose();
            const freshWidget = new widgets_1.Widget();
            freshWidget.id = 'dead-widget';
            getOrCreateWidgetStub.withArgs('dead-widget').resolves(freshWidget);
            const savedLayout = {
                leftPanel: {
                    type: 'sidepanel',
                    items: [
                        { widget: liveWidget, rank: 0, expanded: true },
                        { widget: disposedWidget, rank: 1, expanded: false }
                    ]
                },
                mainPanel: undefined,
                bottomPanel: undefined
            };
            await service.switchPerspective('perspA');
            await service.switchPerspective('perspB');
            service.setSavedLayout('perspA', savedLayout);
            getOrCreateWidgetStub.resetHistory();
            setLayoutDataStub.resetHistory();
            await service.switchPerspective('perspA');
            // Only the disposed widget should trigger getOrCreateWidget
            (0, chai_1.expect)(getOrCreateWidgetStub.calledOnce).to.be.true;
            (0, chai_1.expect)(getOrCreateWidgetStub.calledWith('dead-widget')).to.be.true;
            // The live widget should remain unchanged
            const restoredLayout = setLayoutDataStub.firstCall.args[0];
            (0, chai_1.expect)(restoredLayout.leftPanel.items[0].widget).to.equal(liveWidget);
            (0, chai_1.expect)(restoredLayout.leftPanel.items[1].widget).to.equal(freshWidget);
        });
        it('should handle nested split-area configs', async () => {
            service.registerPerspective({
                id: 'perspA',
                label: 'A',
                viewPlacements: new Map()
            });
            service.registerPerspective({
                id: 'perspB',
                label: 'B',
                viewPlacements: new Map()
            });
            const disposedWidget = new widgets_1.Widget();
            disposedWidget.id = 'nested-widget';
            disposedWidget.dispose();
            const freshWidget = new widgets_1.Widget();
            freshWidget.id = 'nested-widget';
            getOrCreateWidgetStub.withArgs('nested-widget').resolves(freshWidget);
            const liveWidget = new widgets_1.Widget();
            liveWidget.id = 'other-widget';
            const savedLayout = {
                mainPanel: {
                    main: {
                        type: 'split-area',
                        orientation: 'horizontal',
                        sizes: [0.5, 0.5],
                        children: [
                            {
                                type: 'tab-area',
                                widgets: [liveWidget],
                                currentIndex: 0
                            },
                            {
                                type: 'tab-area',
                                widgets: [disposedWidget],
                                currentIndex: 0
                            }
                        ]
                    }
                },
                bottomPanel: undefined
            };
            await service.switchPerspective('perspA');
            await service.switchPerspective('perspB');
            service.setSavedLayout('perspA', savedLayout);
            getOrCreateWidgetStub.resetHistory();
            setLayoutDataStub.resetHistory();
            await service.switchPerspective('perspA');
            (0, chai_1.expect)(getOrCreateWidgetStub.calledWith('nested-widget')).to.be.true;
            const restoredLayout = setLayoutDataStub.firstCall.args[0];
            const splitArea = restoredLayout.mainPanel.main;
            (0, chai_1.expect)(splitArea.children[0].widgets[0]).to.equal(liveWidget);
            (0, chai_1.expect)(splitArea.children[1].widgets[0]).to.equal(freshWidget);
        });
        it('should handle empty/missing panel sections', async () => {
            service.registerPerspective({
                id: 'perspA',
                label: 'A',
                viewPlacements: new Map()
            });
            service.registerPerspective({
                id: 'perspB',
                label: 'B',
                viewPlacements: new Map()
            });
            const savedLayout = {
                mainPanel: undefined,
                bottomPanel: undefined,
                leftPanel: undefined,
                rightPanel: undefined
            };
            await service.switchPerspective('perspA');
            await service.switchPerspective('perspB');
            service.setSavedLayout('perspA', savedLayout);
            setLayoutDataStub.resetHistory();
            // Should not throw
            await service.switchPerspective('perspA');
            (0, chai_1.expect)(setLayoutDataStub.calledOnce).to.be.true;
        });
        it('should heal bottom panel disposed widgets', async () => {
            service.registerPerspective({
                id: 'perspA',
                label: 'A',
                viewPlacements: new Map()
            });
            service.registerPerspective({
                id: 'perspB',
                label: 'B',
                viewPlacements: new Map()
            });
            const disposedWidget = new widgets_1.Widget();
            disposedWidget.id = 'bottom-widget';
            disposedWidget.dispose();
            const freshWidget = new widgets_1.Widget();
            freshWidget.id = 'bottom-widget';
            getOrCreateWidgetStub.withArgs('bottom-widget').resolves(freshWidget);
            const savedLayout = {
                mainPanel: undefined,
                bottomPanel: {
                    config: {
                        main: {
                            type: 'tab-area',
                            widgets: [disposedWidget],
                            currentIndex: 0
                        }
                    }
                }
            };
            await service.switchPerspective('perspA');
            await service.switchPerspective('perspB');
            service.setSavedLayout('perspA', savedLayout);
            getOrCreateWidgetStub.resetHistory();
            setLayoutDataStub.resetHistory();
            await service.switchPerspective('perspA');
            (0, chai_1.expect)(getOrCreateWidgetStub.calledWith('bottom-widget')).to.be.true;
            const restoredLayout = setLayoutDataStub.firstCall.args[0];
            (0, chai_1.expect)(restoredLayout.bottomPanel.config.main.widgets[0]).to.equal(freshWidget);
        });
        it('should heal right panel disposed widgets', async () => {
            service.registerPerspective({
                id: 'perspA',
                label: 'A',
                viewPlacements: new Map()
            });
            service.registerPerspective({
                id: 'perspB',
                label: 'B',
                viewPlacements: new Map()
            });
            const disposedWidget = new widgets_1.Widget();
            disposedWidget.id = 'right-widget';
            disposedWidget.dispose();
            const freshWidget = new widgets_1.Widget();
            freshWidget.id = 'right-widget';
            getOrCreateWidgetStub.withArgs('right-widget').resolves(freshWidget);
            const savedLayout = {
                mainPanel: undefined,
                bottomPanel: undefined,
                rightPanel: {
                    type: 'sidepanel',
                    items: [{ widget: disposedWidget, rank: 0, expanded: true }]
                }
            };
            await service.switchPerspective('perspA');
            await service.switchPerspective('perspB');
            service.setSavedLayout('perspA', savedLayout);
            getOrCreateWidgetStub.resetHistory();
            setLayoutDataStub.resetHistory();
            await service.switchPerspective('perspA');
            (0, chai_1.expect)(getOrCreateWidgetStub.calledWith('right-widget')).to.be.true;
            const restoredLayout = setLayoutDataStub.firstCall.args[0];
            (0, chai_1.expect)(restoredLayout.rightPanel.items[0].widget).to.equal(freshWidget);
        });
    });
    describe('Plumbing API (layout persistence)', () => {
        it('should expose defaultPerspectiveId matching the static constant', () => {
            (0, chai_1.expect)(service.defaultPerspectiveId).to.equal(perspective_service_1.PerspectiveServiceImpl.DEFAULT_PERSPECTIVE_ID);
        });
        it('should return default perspective ID when none is set', () => {
            (0, chai_1.expect)(service.getActivePerspectiveId()).to.equal(perspective_service_1.PerspectiveServiceImpl.DEFAULT_PERSPECTIVE_ID);
        });
        it('should return active perspective ID after switching', async () => {
            service.registerPerspective({
                id: 'test-persp',
                label: 'Test',
                viewPlacements: new Map()
            });
            await service.switchPerspective('test-persp');
            (0, chai_1.expect)(service.getActivePerspectiveId()).to.equal('test-persp');
        });
        it('should round-trip getSavedLayout/setSavedLayout', () => {
            const layout = { mainPanel: { widgets: ['w1'] }, bottomPanel: {} };
            service.setSavedLayout('persp-x', layout);
            (0, chai_1.expect)(service.getSavedLayout('persp-x')).to.equal(layout);
        });
        it('should return undefined for non-existent saved layout', () => {
            (0, chai_1.expect)(service.getSavedLayout('no-such-persp')).to.be.undefined;
        });
        it('should return correct saved perspective IDs', () => {
            const layout1 = { mainPanel: {} };
            const layout2 = { mainPanel: {} };
            service.setSavedLayout('a', layout1);
            service.setSavedLayout('b', layout2);
            const ids = service.getSavedPerspectiveIds();
            (0, chai_1.expect)(ids).to.include('a');
            (0, chai_1.expect)(ids).to.include('b');
            (0, chai_1.expect)(ids).to.have.lengthOf(2);
        });
        it('should set active perspective ID only for registered perspectives', () => {
            service.registerPerspective({
                id: 'registered',
                label: 'Registered',
                viewPlacements: new Map()
            });
            (0, chai_1.expect)(service.setActivePerspectiveId('registered')).to.be.true;
            (0, chai_1.expect)(service.getActivePerspectiveId()).to.equal('registered');
            (0, chai_1.expect)(service.setActivePerspectiveId('unregistered')).to.be.false;
            (0, chai_1.expect)(service.getActivePerspectiveId()).to.equal('registered');
        });
        it('should clear all saved layouts', () => {
            const layout = { mainPanel: {} };
            service.setSavedLayout('a', layout);
            service.setSavedLayout('b', layout);
            service.clearSavedLayouts();
            (0, chai_1.expect)(service.getSavedPerspectiveIds()).to.have.lengthOf(0);
            (0, chai_1.expect)(service.getSavedLayout('a')).to.be.undefined;
            (0, chai_1.expect)(service.getSavedLayout('b')).to.be.undefined;
        });
    });
    describe('collectWidgetIds', () => {
        it('should collect IDs from side panel items', () => {
            const widgetA = new widgets_1.Widget();
            widgetA.id = 'widget-a';
            const widgetB = new widgets_1.Widget();
            widgetB.id = 'widget-b';
            const layout = {
                leftPanel: {
                    type: 'sidepanel',
                    items: [
                        { widget: widgetA, rank: 0, expanded: true },
                        { widget: widgetB, rank: 1, expanded: false }
                    ]
                },
                mainPanel: undefined,
                bottomPanel: undefined
            };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ids = service.collectWidgetIds(layout);
            (0, chai_1.expect)(ids.has('widget-a')).to.be.true;
            (0, chai_1.expect)(ids.has('widget-b')).to.be.true;
            (0, chai_1.expect)(ids.size).to.equal(2);
        });
        it('should collect IDs from dock panel tab-areas', () => {
            const widgetA = new widgets_1.Widget();
            widgetA.id = 'tab-widget-a';
            const widgetB = new widgets_1.Widget();
            widgetB.id = 'tab-widget-b';
            const layout = {
                mainPanel: {
                    main: {
                        type: 'tab-area',
                        widgets: [widgetA, widgetB],
                        currentIndex: 0
                    }
                },
                bottomPanel: undefined
            };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ids = service.collectWidgetIds(layout);
            (0, chai_1.expect)(ids.has('tab-widget-a')).to.be.true;
            (0, chai_1.expect)(ids.has('tab-widget-b')).to.be.true;
            (0, chai_1.expect)(ids.size).to.equal(2);
        });
        it('should collect IDs from nested split-areas', () => {
            const widgetA = new widgets_1.Widget();
            widgetA.id = 'split-a';
            const widgetB = new widgets_1.Widget();
            widgetB.id = 'split-b';
            const layout = {
                mainPanel: {
                    main: {
                        type: 'split-area',
                        orientation: 'horizontal',
                        sizes: [0.5, 0.5],
                        children: [
                            {
                                type: 'tab-area',
                                widgets: [widgetA],
                                currentIndex: 0
                            },
                            {
                                type: 'tab-area',
                                widgets: [widgetB],
                                currentIndex: 0
                            }
                        ]
                    }
                },
                bottomPanel: undefined
            };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ids = service.collectWidgetIds(layout);
            (0, chai_1.expect)(ids.has('split-a')).to.be.true;
            (0, chai_1.expect)(ids.has('split-b')).to.be.true;
            (0, chai_1.expect)(ids.size).to.equal(2);
        });
        it('should return empty set for empty/missing layout sections', () => {
            const layout = {
                mainPanel: undefined,
                bottomPanel: undefined,
                leftPanel: undefined,
                rightPanel: undefined
            };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ids = service.collectWidgetIds(layout);
            (0, chai_1.expect)(ids.size).to.equal(0);
        });
        it('should skip undefined widget entries in tab-areas', () => {
            const widgetA = new widgets_1.Widget();
            widgetA.id = 'valid-widget';
            const layout = {
                mainPanel: {
                    main: {
                        type: 'tab-area',
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        widgets: [widgetA, undefined],
                        currentIndex: 0
                    }
                },
                bottomPanel: undefined
            };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ids = service.collectWidgetIds(layout);
            (0, chai_1.expect)(ids.has('valid-widget')).to.be.true;
            (0, chai_1.expect)(ids.size).to.equal(1);
        });
        it('should skip undefined widget entries in side panel items', () => {
            const widgetA = new widgets_1.Widget();
            widgetA.id = 'valid-side-widget';
            const layout = {
                leftPanel: {
                    type: 'sidepanel',
                    items: [
                        { widget: widgetA, rank: 0, expanded: true },
                        { widget: undefined, rank: 1, expanded: false }
                    ]
                },
                mainPanel: undefined,
                bottomPanel: undefined
            };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ids = service.collectWidgetIds(layout);
            (0, chai_1.expect)(ids.has('valid-side-widget')).to.be.true;
            (0, chai_1.expect)(ids.size).to.equal(1);
        });
        it('should collect IDs from bottom panel', () => {
            const widgetA = new widgets_1.Widget();
            widgetA.id = 'bottom-widget';
            const layout = {
                mainPanel: undefined,
                bottomPanel: {
                    config: {
                        main: {
                            type: 'tab-area',
                            widgets: [widgetA],
                            currentIndex: 0
                        }
                    }
                }
            };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ids = service.collectWidgetIds(layout);
            (0, chai_1.expect)(ids.has('bottom-widget')).to.be.true;
            (0, chai_1.expect)(ids.size).to.equal(1);
        });
        it('should collect IDs from all panels', () => {
            const leftWidget = new widgets_1.Widget();
            leftWidget.id = 'left-w';
            const rightWidget = new widgets_1.Widget();
            rightWidget.id = 'right-w';
            const mainWidget = new widgets_1.Widget();
            mainWidget.id = 'main-w';
            const bottomWidget = new widgets_1.Widget();
            bottomWidget.id = 'bottom-w';
            const layout = {
                leftPanel: {
                    type: 'sidepanel',
                    items: [{ widget: leftWidget, rank: 0, expanded: true }]
                },
                rightPanel: {
                    type: 'sidepanel',
                    items: [{ widget: rightWidget, rank: 0, expanded: true }]
                },
                mainPanel: {
                    main: {
                        type: 'tab-area',
                        widgets: [mainWidget],
                        currentIndex: 0
                    }
                },
                bottomPanel: {
                    config: {
                        main: {
                            type: 'tab-area',
                            widgets: [bottomWidget],
                            currentIndex: 0
                        }
                    }
                }
            };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ids = service.collectWidgetIds(layout);
            (0, chai_1.expect)(ids.has('left-w')).to.be.true;
            (0, chai_1.expect)(ids.has('right-w')).to.be.true;
            (0, chai_1.expect)(ids.has('main-w')).to.be.true;
            (0, chai_1.expect)(ids.has('bottom-w')).to.be.true;
            (0, chai_1.expect)(ids.size).to.equal(4);
        });
    });
    describe('detachStrayWidgets', () => {
        it('should detach a left-panel widget whose ID is not in the layout ID set', () => {
            const strayWidget = new widgets_1.Widget();
            strayWidget.id = 'stray-left';
            const panel = new widgets_1.Panel();
            widgets_1.Widget.attach(panel, document.body);
            panel.addWidget(strayWidget);
            (0, chai_1.expect)(strayWidget.isAttached).to.be.true;
            getWidgetsStub.withArgs('left').returns([strayWidget]);
            getWidgetsStub.withArgs('right').returns([]);
            const widgetIds = new Set();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            service.detachStrayWidgets(widgetIds);
            (0, chai_1.expect)(strayWidget.isAttached).to.be.false;
            panel.dispose();
        });
        it('should detach a right-panel widget whose ID is not in the layout ID set', () => {
            const strayWidget = new widgets_1.Widget();
            strayWidget.id = 'stray-right';
            const panel = new widgets_1.Panel();
            widgets_1.Widget.attach(panel, document.body);
            panel.addWidget(strayWidget);
            (0, chai_1.expect)(strayWidget.isAttached).to.be.true;
            getWidgetsStub.withArgs('left').returns([]);
            getWidgetsStub.withArgs('right').returns([strayWidget]);
            const widgetIds = new Set();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            service.detachStrayWidgets(widgetIds);
            (0, chai_1.expect)(strayWidget.isAttached).to.be.false;
            panel.dispose();
        });
        it('should NOT detach a widget whose ID IS in the layout ID set', () => {
            const keptWidget = new widgets_1.Widget();
            keptWidget.id = 'kept-widget';
            const panel = new widgets_1.Panel();
            widgets_1.Widget.attach(panel, document.body);
            panel.addWidget(keptWidget);
            (0, chai_1.expect)(keptWidget.isAttached).to.be.true;
            getWidgetsStub.withArgs('left').returns([keptWidget]);
            getWidgetsStub.withArgs('right').returns([]);
            const widgetIds = new Set(['kept-widget']);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            service.detachStrayWidgets(widgetIds);
            (0, chai_1.expect)(keptWidget.isAttached).to.be.true;
            panel.dispose();
        });
        it('should handle empty side panels gracefully', () => {
            getWidgetsStub.withArgs('left').returns([]);
            getWidgetsStub.withArgs('right').returns([]);
            const widgetIds = new Set();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (0, chai_1.expect)(() => service.detachStrayWidgets(widgetIds)).to.not.throw();
        });
        it('should detach non-viewPlacements widget that leaked from another perspective', () => {
            // Simulate: Outline widget is in the left panel but not in the target layout
            const outlineWidget = new widgets_1.Widget();
            outlineWidget.id = 'outline-view';
            const panel = new widgets_1.Panel();
            widgets_1.Widget.attach(panel, document.body);
            panel.addWidget(outlineWidget);
            getWidgetsStub.withArgs('left').returns([outlineWidget]);
            getWidgetsStub.withArgs('right').returns([]);
            // Target layout has no widgets — outline should be detached
            const widgetIds = new Set();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            service.detachStrayWidgets(widgetIds);
            (0, chai_1.expect)(outlineWidget.isAttached).to.be.false;
            panel.dispose();
        });
        it('should detach multiple stray widgets from both panels', () => {
            const leftStray = new widgets_1.Widget();
            leftStray.id = 'left-stray';
            const rightStray = new widgets_1.Widget();
            rightStray.id = 'right-stray';
            const leftPanel = new widgets_1.Panel();
            const rightPanel = new widgets_1.Panel();
            widgets_1.Widget.attach(leftPanel, document.body);
            widgets_1.Widget.attach(rightPanel, document.body);
            leftPanel.addWidget(leftStray);
            rightPanel.addWidget(rightStray);
            getWidgetsStub.withArgs('left').returns([leftStray]);
            getWidgetsStub.withArgs('right').returns([rightStray]);
            const widgetIds = new Set();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            service.detachStrayWidgets(widgetIds);
            (0, chai_1.expect)(leftStray.isAttached).to.be.false;
            (0, chai_1.expect)(rightStray.isAttached).to.be.false;
            leftPanel.dispose();
            rightPanel.dispose();
        });
        describe('stray widget cleanup during perspective switch', () => {
            let parentPanel;
            beforeEach(() => {
                parentPanel = new widgets_1.Panel();
                widgets_1.Widget.attach(parentPanel, document.body);
            });
            afterEach(() => {
                parentPanel.dispose();
            });
            it('should detach stray widgets when restoring a saved layout', async () => {
                const chatWidget = new widgets_1.Widget();
                chatWidget.id = 'chat-view';
                parentPanel.addWidget(chatWidget);
                getOrCreateWidgetStub.withArgs('chat-view').resolves(chatWidget);
                service.registerPerspective({
                    id: 'perspA',
                    label: 'A',
                    viewPlacements: new Map([['chat-view', 'main']])
                });
                service.registerPerspective({
                    id: 'perspB',
                    label: 'B',
                    viewPlacements: new Map()
                });
                // Activate A (first time — viewPlacements applied)
                await service.switchPerspective('perspA');
                // Simulate saving A's layout WITHOUT chat-view (user closed it)
                const layoutAWithoutChat = {
                    mainPanel: {
                        main: {
                            type: 'tab-area',
                            widgets: [],
                            currentIndex: -1
                        }
                    },
                    bottomPanel: undefined
                };
                getLayoutDataStub.returns(layoutAWithoutChat);
                // Switch to B (saves A's layout without chat)
                await service.switchPerspective('perspB');
                // chat-view is still attached (simulating the stray scenario)
                (0, chai_1.expect)(chatWidget.isAttached).to.be.true;
                // When switching back to A, shell.getWidgets returns the stray
                getWidgetsStub.withArgs('left').returns([chatWidget]);
                getWidgetsStub.withArgs('right').returns([]);
                // Switch back to A — should restore layout and detach stray chat-view
                await service.switchPerspective('perspA');
                (0, chai_1.expect)(chatWidget.isAttached).to.be.false;
            });
            it('should NOT detach a widget that IS in the saved layout (user customization preserved)', async () => {
                const chatWidget = new widgets_1.Widget();
                chatWidget.id = 'chat-view';
                parentPanel.addWidget(chatWidget);
                getOrCreateWidgetStub.withArgs('chat-view').resolves(chatWidget);
                service.registerPerspective({
                    id: 'perspA',
                    label: 'A',
                    viewPlacements: new Map([['chat-view', 'main']])
                });
                service.registerPerspective({
                    id: 'perspB',
                    label: 'B',
                    viewPlacements: new Map()
                });
                // Activate A
                await service.switchPerspective('perspA');
                // Simulate saving A's layout WITH chat-view in right panel
                const layoutAWithChat = {
                    rightPanel: {
                        type: 'sidepanel',
                        items: [{ widget: chatWidget, rank: 0, expanded: true }]
                    },
                    mainPanel: undefined,
                    bottomPanel: undefined
                };
                getLayoutDataStub.returns(layoutAWithChat);
                // Switch to B (saves A's layout with chat)
                await service.switchPerspective('perspB');
                // When switching back, chat is in the right panel
                getWidgetsStub.withArgs('left').returns([]);
                getWidgetsStub.withArgs('right').returns([chatWidget]);
                // Switch back to A — chat IS in layout, should NOT be detached
                await service.switchPerspective('perspA');
                (0, chai_1.expect)(chatWidget.isAttached).to.be.true;
            });
            it('should detach non-viewPlacements widget leaking from another perspective', async () => {
                // Outline is not in AI First's viewPlacements
                const outlineWidget = new widgets_1.Widget();
                outlineWidget.id = 'outline-view';
                parentPanel.addWidget(outlineWidget);
                service.registerPerspective({
                    id: 'ai-first',
                    label: 'AI First',
                    viewPlacements: new Map([['chat-view', 'main']])
                });
                service.registerPerspective({
                    id: 'default-persp',
                    label: 'Default',
                    viewPlacements: new Map()
                });
                // Activate AI First
                await service.switchPerspective('ai-first');
                // Save AI First layout without outline
                const aiLayout = {
                    mainPanel: {
                        main: {
                            type: 'tab-area',
                            widgets: [],
                            currentIndex: -1
                        }
                    },
                    bottomPanel: undefined
                };
                getLayoutDataStub.returns(aiLayout);
                // Switch to default (saves AI First layout)
                await service.switchPerspective('default-persp');
                // Outline is open in default's left panel
                (0, chai_1.expect)(outlineWidget.isAttached).to.be.true;
                // Switch back to AI First — outline is a stray
                getWidgetsStub.withArgs('left').returns([outlineWidget]);
                getWidgetsStub.withArgs('right').returns([]);
                await service.switchPerspective('ai-first');
                // Outline should be detached (not in AI First's saved layout)
                (0, chai_1.expect)(outlineWidget.isAttached).to.be.false;
            });
        });
    });
});
//# sourceMappingURL=perspective-service.spec.js.map