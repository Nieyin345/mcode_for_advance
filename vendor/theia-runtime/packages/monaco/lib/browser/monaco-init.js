"use strict";
// *****************************************************************************
// Copyright (C) 2023 STMicroelectronics and others.
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
exports.MonacoInit = exports.contentHoverWidgetPatcher = void 0;
const tslib_1 = require("tslib");
/*
 * The code in this file is responsible for overriding service implementations in the Monaco editor with our own Theia-based implementations.
 * Since we only get a single chance to call `StandaloneServices.initialize()` with our overrides, we need to make sure that initialize is called before the first call to
 * `StandaloneServices.get()` or `StandaloneServices.initialize()`. As we do not control the mechanics of Inversify instance constructions, the approach here is to call
 * `MonacoInit.init()` from the `index.js` file after all container modules are loaded, but before the first object is fetched from it.
 * `StandaloneServices.initialize()` is called with service descriptors, not service instances. This lets us finish all overrides before any inversify object is constructed and
 * might call `initialize()` while being constructed.
 * The service descriptors require a constructor function, so we declare dummy class for each Monaco service we override. But instead of returning an instance of the dummy class,
 * we fetch the implementation of the monaco service from the inversify container.
 * The inversify-constructed services must not call StandaloneServices.get() or StandaloneServices.initialize() from their constructors. Calling `get`()` in postConstruct methods
 * is allowed.
 */
// Monaco's localization override is handled at bundling time by the `monacoNlsPlugin` of
// @theia/bundle-plugin, which replaces @theia/monaco-editor-core/esm/vs/nls with
// packages/monaco/src/browser/monaco-nls.ts.
const inversify_1 = require("@theia/core/shared/inversify");
const codeEditorService_1 = require("@theia/monaco-editor-core/esm/vs/editor/browser/services/codeEditorService");
const standaloneServices_1 = require("@theia/monaco-editor-core/esm/vs/editor/standalone/browser/standaloneServices");
const descriptors_1 = require("@theia/monaco-editor-core/esm/vs/platform/instantiation/common/descriptors");
const instantiation_1 = require("@theia/monaco-editor-core/esm/vs/platform/instantiation/common/instantiation");
const instantiationService_1 = require("@theia/monaco-editor-core/esm/vs/platform/instantiation/common/instantiationService");
const serviceCollection_1 = require("@theia/monaco-editor-core/esm/vs/platform/instantiation/common/serviceCollection");
const monaco_editor_service_1 = require("./monaco-editor-service");
const configuration_1 = require("@theia/monaco-editor-core/esm/vs/platform/configuration/common/configuration");
const resolverService_1 = require("@theia/monaco-editor-core/esm/vs/editor/common/services/resolverService");
const monaco_frontend_module_1 = require("./monaco-frontend-module");
const monaco_text_model_service_1 = require("./monaco-text-model-service");
const monaco_context_menu_1 = require("./monaco-context-menu");
const contextView_1 = require("@theia/monaco-editor-core/esm/vs/platform/contextview/browser/contextView");
const contextkey_1 = require("@theia/monaco-editor-core/esm/vs/platform/contextkey/common/contextkey");
const themeService_1 = require("@theia/monaco-editor-core/esm/vs/platform/theme/common/themeService");
const monaco_bulk_edit_service_1 = require("./monaco-bulk-edit-service");
const monaco_command_service_1 = require("./monaco-command-service");
const bulkEditService_1 = require("@theia/monaco-editor-core/esm/vs/editor/browser/services/bulkEditService");
const commands_1 = require("@theia/monaco-editor-core/esm/vs/platform/commands/common/commands");
const monaco_quick_input_service_1 = require("./monaco-quick-input-service");
const quickInput_1 = require("@theia/monaco-editor-core/esm/vs/platform/quickinput/common/quickInput");
const standaloneTheme_1 = require("@theia/monaco-editor-core/esm/vs/editor/standalone/common/standaloneTheme");
const monaco_standalone_theme_service_1 = require("./monaco-standalone-theme-service");
const content_hover_widget_patcher_1 = require("./content-hover-widget-patcher");
const hover_1 = require("@theia/monaco-editor-core/esm/vs/platform/hover/browser/hover");
const hoverDelegate2_1 = require("@theia/monaco-editor-core/esm/vs/base/browser/ui/hover/hoverDelegate2");
const workspace_1 = require("@theia/monaco-editor-core/esm/vs/platform/workspace/common/workspace");
const monaco_workspace_context_service_1 = require("./monaco-workspace-context-service");
const layoutService_1 = require("@theia/monaco-editor-core/esm/vs/platform/layout/browser/layoutService");
const event_1 = require("@theia/monaco-editor-core/esm/vs/base/common/event");
const dom = require("@theia/monaco-editor-core/esm/vs/base/browser/dom");
const window_1 = require("@theia/monaco-editor-core/esm/vs/base/browser/window");
const core_1 = require("@theia/core");
exports.contentHoverWidgetPatcher = (0, content_hover_widget_patcher_1.createContentHoverWidgetPatcher)();
let MonacoEditorServiceConstructor = class MonacoEditorServiceConstructor {
    /**
     * MonacoEditorService needs other Monaco services as constructor parameters, so we need to do use a factory for constructing the service. If we want the singleton instance,
     * we need to fetch it from the `StandaloneServices` class instead of injecting it.
     * @param container
     * @param contextKeyService
     * @param themeService
     */
    constructor(container, contextKeyService, themeService) {
        return container.get(monaco_editor_service_1.MonacoEditorServiceFactory)(contextKeyService, themeService);
    }
    ;
};
MonacoEditorServiceConstructor = tslib_1.__decorate([
    tslib_1.__param(1, contextkey_1.IContextKeyService),
    tslib_1.__param(2, themeService_1.IThemeService),
    tslib_1.__metadata("design:paramtypes", [inversify_1.Container, Object, Object])
], MonacoEditorServiceConstructor);
class MonacoConfigurationServiceConstructor {
    constructor(container) {
        return container.get(monaco_frontend_module_1.MonacoConfigurationService);
    }
}
class MonacoTextModelServiceConstructor {
    constructor(container) {
        return container.get(monaco_text_model_service_1.MonacoTextModelService);
    }
}
class MonacoContextMenuServiceConstructor {
    constructor(container) {
        return container.get(monaco_context_menu_1.MonacoContextMenuService);
    }
}
class MonacoBulkEditServiceConstructor {
    constructor(container) {
        return container.get(monaco_bulk_edit_service_1.MonacoBulkEditService);
    }
}
class MonacoCommandServiceConstructor {
    constructor(container) {
        return container.get(monaco_command_service_1.MonacoCommandService);
    }
}
class MonacoQuickInputImplementationConstructor {
    constructor(container) {
        return container.get(monaco_quick_input_service_1.MonacoQuickInputImplementation);
    }
}
class MonacoStandaloneThemeServiceConstructor {
    constructor(container) {
        return new monaco_standalone_theme_service_1.MonacoStandaloneThemeService();
    }
}
class MonacoWorkspaceContextServiceConstructor {
    constructor(container) {
        return container.get(monaco_workspace_context_service_1.MonacoWorkspaceContextService);
    }
}
/**
 * Layout service that returns the Theia application shell as the main container
 * instead of the first Monaco editor's container DOM node. This ensures that
 * Monaco UI elements like the quick input are positioned relative to the full
 * application layout rather than a single editor.
 */
class MonacoLayoutService {
    constructor() {
        this.onDidLayoutMainContainer = event_1.Event.None;
        this.onDidLayoutActiveContainer = event_1.Event.None;
        this.onDidLayoutContainer = event_1.Event.None;
        this.onDidChangeActiveContainer = event_1.Event.None;
        this.onDidAddContainer = event_1.Event.None;
        this.mainContainerOffset = { top: 0, quickPickTop: 0 };
        this.activeContainerOffset = { top: 0, quickPickTop: 0 };
    }
    get mainContainer() {
        return window_1.mainWindow.document.getElementById('theia-app-shell') ?? window_1.mainWindow.document.body;
    }
    get activeContainer() {
        return this.mainContainer;
    }
    get mainContainerDimension() {
        return dom.getClientArea(this.mainContainer);
    }
    get activeContainerDimension() {
        return dom.getClientArea(this.activeContainer);
    }
    get containers() {
        return [this.mainContainer];
    }
    getContainer() {
        return this.activeContainer;
    }
    whenContainerStylesLoaded() {
        return undefined;
    }
    focus() {
        this.mainContainer.focus();
    }
}
class MonacoLayoutServiceConstructor {
    constructor() {
        return new MonacoLayoutService();
    }
}
var MonacoInit;
(function (MonacoInit) {
    function init(container) {
        const overrides = {
            [codeEditorService_1.ICodeEditorService.toString()]: new descriptors_1.SyncDescriptor(MonacoEditorServiceConstructor, [container]),
            [configuration_1.IConfigurationService.toString()]: new descriptors_1.SyncDescriptor(MonacoConfigurationServiceConstructor, [container]),
            [resolverService_1.ITextModelService.toString()]: new descriptors_1.SyncDescriptor(MonacoTextModelServiceConstructor, [container]),
            [contextView_1.IContextMenuService.toString()]: new descriptors_1.SyncDescriptor(MonacoContextMenuServiceConstructor, [container]),
            [bulkEditService_1.IBulkEditService.toString()]: new descriptors_1.SyncDescriptor(MonacoBulkEditServiceConstructor, [container]),
            [commands_1.ICommandService.toString()]: new descriptors_1.SyncDescriptor(MonacoCommandServiceConstructor, [container]),
            [quickInput_1.IQuickInputService.toString()]: new descriptors_1.SyncDescriptor(MonacoQuickInputImplementationConstructor, [container]),
            [standaloneTheme_1.IStandaloneThemeService.toString()]: new descriptors_1.SyncDescriptor(MonacoStandaloneThemeServiceConstructor, []),
            [workspace_1.IWorkspaceContextService.toString()]: new descriptors_1.SyncDescriptor(MonacoWorkspaceContextServiceConstructor, [container]),
            [layoutService_1.ILayoutService.toString()]: new descriptors_1.SyncDescriptor(MonacoLayoutServiceConstructor, [])
        };
        // Detect whether StandaloneServices was already initialized before we get a chance to
        // apply our overrides.  `withServices` calls the callback synchronously when `initialized`
        // is already `true`, so the flag will be set before we proceed.  If it remains `false`,
        // our `initialize(overrides)` call below will be the first and our descriptors will be
        // applied normally.
        // @monaco-uplift: verify that `withServices` still calls the callback synchronously when
        // already initialized — if this changes, the premature-initialization detection will break.
        let isInitialized = false;
        standaloneServices_1.StandaloneServices.withServices(() => {
            isInitialized = true;
            return core_1.Disposable.NULL;
        });
        const servicesInitializedBeforeOverrides = isInitialized;
        // Try the standard initialization path first.
        standaloneServices_1.StandaloneServices.initialize(overrides);
        // If StandaloneServices was already initialized (e.g., by a premature StandaloneServices.get() call
        // triggered as a side-effect during module loading), the call above is a no-op and our overrides are
        // silently dropped.  Detect this situation, warn about it, and inject our service descriptors directly
        // into the internal service collection so that they are used when the services are next resolved.
        //
        // We only need this fallback when initialize() was a no-op.  On the normal startup path,
        // initialize() succeeds and any services that get instantiated during that call (e.g. as
        // dependencies of editor features) are created from *our* Theia descriptors — not the
        // Monaco defaults — so they are perfectly fine and must not be flagged.
        if (servicesInitializedBeforeOverrides) {
            patchServices(overrides);
        }
        // Make sure the global base hover delegate is initialized as otherwise the quick input will throw an error and not update correctly
        // in case no Monaco editor was constructed before and items with keybindings are shown. See #15042.
        (0, hoverDelegate2_1.setBaseLayerHoverDelegate)(standaloneServices_1.StandaloneServices.get(hover_1.IHoverService));
    }
    MonacoInit.init = init;
})(MonacoInit || (exports.MonacoInit = MonacoInit = {}));
// @monaco-uplift: verify that the concrete InstantiationService class still exposes a
// private `_services: ServiceCollection` property.  See monaco-init.spec.ts for a CI
// guard that will flag a mismatch after a Monaco version bump.
function patchServices(overrides) {
    const instantiationService = standaloneServices_1.StandaloneServices.get(instantiation_1.IInstantiationService);
    if (!(instantiationService instanceof instantiationService_1.InstantiationService)) {
        console.error('StandaloneServices returned an IInstantiationService that is not an instance of InstantiationService. '
            + 'Theia service overrides cannot be patched in after premature initialization. '
            + 'Investigate whether Monaco\'s internal InstantiationService class has been refactored.');
        return;
    }
    const serviceCollection = instantiationService['_services'];
    if (!(serviceCollection instanceof serviceCollection_1.ServiceCollection)) {
        console.error('InstantiationService._services is not a ServiceCollection (got '
            + (serviceCollection === undefined ? 'undefined' : typeof serviceCollection)
            + '). Theia service overrides cannot be patched in after premature initialization. '
            + 'Investigate whether Monaco\'s InstantiationService internals have changed.');
        return;
    }
    const patchedServices = [];
    const alreadyInstantiatedServices = [];
    for (const serviceId of Object.keys(overrides)) {
        const serviceIdentifier = (0, instantiation_1.createDecorator)(serviceId);
        const existing = serviceCollection.get(serviceIdentifier);
        if (existing instanceof descriptors_1.SyncDescriptor && existing !== overrides[serviceId]) {
            // The override was not applied by initialize() – patch it in manually.
            serviceCollection.set(serviceIdentifier, overrides[serviceId]);
            patchedServices.push(serviceId);
        }
        else if (existing !== undefined && !(existing instanceof descriptors_1.SyncDescriptor)) {
            // The service was already instantiated from the default Monaco
            // implementation – we cannot override it anymore.
            alreadyInstantiatedServices.push(serviceId);
        }
    }
    if (patchedServices.length > 0) {
        console.warn('StandaloneServices was already initialized before MonacoInit.init() was called. '
            + 'This typically happens when a StandaloneServices.get() call is triggered as a side-effect during module loading. '
            + 'The following Theia service overrides had to be patched in after the fact: '
            + patchedServices.join(', ')
            + '. Investigate the module loading order to prevent premature initialization.');
    }
    if (alreadyInstantiatedServices.length > 0) {
        console.error('StandaloneServices was already initialized and the following services were already instantiated '
            + 'before MonacoInit.init() could apply Theia overrides: '
            + alreadyInstantiatedServices.join(', ')
            + '. These services are using the default Monaco implementations instead of Theia\'s. '
            + 'This may cause unexpected behavior. Investigate which code triggers premature service resolution.');
    }
}
//# sourceMappingURL=monaco-init.js.map