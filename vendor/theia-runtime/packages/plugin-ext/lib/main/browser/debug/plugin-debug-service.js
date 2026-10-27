"use strict";
// *****************************************************************************
// Copyright (C) 2018 Red Hat, Inc. and others.
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
exports.PluginDebugService = void 0;
const tslib_1 = require("tslib");
const debug_service_1 = require("@theia/debug/lib/common/debug-service");
const debounce = require("@theia/core/shared/lodash.debounce");
const core_1 = require("@theia/core");
const disposable_1 = require("@theia/core/lib/common/disposable");
const inversify_1 = require("@theia/core/shared/inversify");
const ws_connection_provider_1 = require("@theia/core/lib/browser/messaging/ws-connection-provider");
const browser_1 = require("@theia/workspace/lib/browser");
const plugin_api_rpc_1 = require("../../../common/plugin-api-rpc");
/**
 * Debug service to work with plugin and extension contributions.
 */
let PluginDebugService = class PluginDebugService {
    constructor() {
        this.onDidChangeDebuggersEmitter = new core_1.Emitter();
        this.debuggers = [];
        this.contributors = new Map();
        this.configurationProviders = new Map();
        this.toDispose = new disposable_1.DisposableCollection(this.onDidChangeDebuggersEmitter);
        // Debug configurations discovered from plugin manifests (activation events) before providers register.
        // Maps type -> { label, refCount } since multiple plugins may register the same type.
        this.dynamicDebugConfigsFromManifests = new Map();
        this.onDidChangeDebugConfigurationProvidersEmitter = new core_1.Emitter();
        // maps session and contribution
        this.sessionId2contrib = new Map();
        // debouncing to send a single notification for multiple registrations at initialization time
        this.fireOnDidConfigurationProvidersChanged = debounce(() => {
            this.onDidChangeDebugConfigurationProvidersEmitter.fire();
        }, 100);
    }
    get onDidChangeDebuggers() {
        return this.onDidChangeDebuggersEmitter.event;
    }
    get onDidChangeDebugConfigurationProviders() {
        return this.onDidChangeDebugConfigurationProvidersEmitter.event;
    }
    init() {
        this.delegated = this.connectionProvider.createProxy(debug_service_1.DebugPath);
        this.toDispose.pushAll([
            disposable_1.Disposable.create(() => this.delegated.dispose()),
            disposable_1.Disposable.create(() => {
                for (const sessionId of this.sessionId2contrib.keys()) {
                    const contrib = this.sessionId2contrib.get(sessionId);
                    contrib.terminateDebugSession(sessionId);
                }
                this.sessionId2contrib.clear();
            })
        ]);
    }
    registerDebugAdapterContribution(contrib) {
        const { type } = contrib;
        if (this.contributors.has(type)) {
            this.logger.warn(`Debugger with type '${type}' already registered.`);
            return disposable_1.Disposable.NULL;
        }
        this.contributors.set(type, contrib);
        return disposable_1.Disposable.create(() => this.unregisterDebugAdapterContribution(type));
    }
    unregisterDebugAdapterContribution(debugType) {
        this.contributors.delete(debugType);
    }
    registerDebugConfigurationProvider(provider) {
        if (this.configurationProviders.has(provider.handle)) {
            const configuration = this.configurationProviders.get(provider.handle);
            if (configuration && configuration.type !== provider.type) {
                this.logger.warn(`Different debug configuration provider with type '${configuration.type}' already registered.`);
                provider.handle = this.configurationProviders.size;
            }
        }
        const handle = provider.handle;
        this.configurationProviders.set(handle, provider);
        this.fireOnDidConfigurationProvidersChanged();
        return disposable_1.Disposable.create(() => this.unregisterDebugConfigurationProvider(handle));
    }
    unregisterDebugConfigurationProvider(handle) {
        this.configurationProviders.delete(handle);
        this.fireOnDidConfigurationProvidersChanged();
    }
    async debugTypes() {
        const debugTypes = new Set(await this.delegated.debugTypes());
        for (const contribution of this.debuggers) {
            debugTypes.add(contribution.type);
        }
        for (const debugType of this.contributors.keys()) {
            debugTypes.add(debugType);
        }
        return [...debugTypes];
    }
    async provideDebugConfigurations(debugType, workspaceFolderUri) {
        const pluginProviders = Array.from(this.configurationProviders.values()).filter(p => (p.triggerKind === plugin_api_rpc_1.DebugConfigurationProviderTriggerKind.Initial &&
            (p.type === debugType || p.type === '*') &&
            p.provideDebugConfigurations));
        if (pluginProviders.length === 0) {
            return this.delegated.provideDebugConfigurations(debugType, workspaceFolderUri);
        }
        const results = [];
        await Promise.all(pluginProviders.map(async (p) => {
            const result = await p.provideDebugConfigurations(workspaceFolderUri);
            if (result) {
                results.push(...result);
            }
        }));
        return results;
    }
    async fetchDynamicDebugConfiguration(name, providerType, folder) {
        const pluginProviders = Array.from(this.configurationProviders.values()).filter(p => (p.triggerKind === plugin_api_rpc_1.DebugConfigurationProviderTriggerKind.Dynamic &&
            p.type === providerType &&
            p.provideDebugConfigurations));
        for (const provider of pluginProviders) {
            const configurations = await provider.provideDebugConfigurations(folder);
            for (const configuration of configurations) {
                if (configuration.name === name) {
                    return configuration;
                }
            }
        }
    }
    /**
     * Registers a dynamic debug configuration type discovered from a plugin manifest.
     * This allows showing provider types in the dropdown before the extension has activated.
     */
    registerDynamicDebugConfigurationType(type, label) {
        const existing = this.dynamicDebugConfigsFromManifests.get(type);
        if (existing) {
            existing.refCount++;
        }
        else {
            this.dynamicDebugConfigsFromManifests.set(type, { label, refCount: 1 });
        }
        this.fireOnDidConfigurationProvidersChanged();
        return disposable_1.Disposable.create(() => {
            const entry = this.dynamicDebugConfigsFromManifests.get(type);
            if (entry) {
                if (entry.refCount <= 1) {
                    this.dynamicDebugConfigsFromManifests.delete(type);
                }
                else {
                    entry.refCount--;
                }
            }
            this.fireOnDidConfigurationProvidersChanged();
        });
    }
    /**
     * Returns dynamic debug configuration providers grouped by label.
     * Each entry contains a label and all the types that share that label.
     * Includes both registered providers and types discovered from plugin manifests.
     */
    getDynamicDebugConfigurationProviders() {
        // Group by label -> types
        const labelToTypes = new Map();
        // Add types from manifests (before activation)
        for (const [type, { label }] of this.dynamicDebugConfigsFromManifests) {
            const types = labelToTypes.get(label) ?? new Set();
            types.add(type);
            labelToTypes.set(label, types);
        }
        // Add types from registered providers, looking up their labels
        for (const provider of this.configurationProviders.values()) {
            if (provider.triggerKind === plugin_api_rpc_1.DebugConfigurationProviderTriggerKind.Dynamic &&
                'provideDebugConfigurations' in provider) {
                const label = this.getDebuggerLabel(provider.type) ?? provider.type;
                const types = labelToTypes.get(label) ?? new Set();
                types.add(provider.type);
                labelToTypes.set(label, types);
            }
        }
        // Convert to array of { label, types }
        return Array.from(labelToTypes.entries()).map(([label, types]) => ({
            label,
            types: Array.from(types)
        }));
    }
    /**
     * Returns the types of dynamic debug configuration providers.
     * @deprecated Use getDynamicDebugConfigurationProviders() instead for proper label support.
     */
    getDynamicDebugConfigurationProviderTypes() {
        return this.getDynamicDebugConfigurationProviders().flatMap(p => p.types);
    }
    /**
     * Gets the label for a debugger type.
     */
    getDebuggerLabel(type) {
        const debugger_ = this.debuggers.find(d => d.type === type);
        return debugger_?.label;
    }
    async provideDynamicDebugConfigurations(folder) {
        const pluginProviders = Array.from(this.configurationProviders.values()).filter(p => (p.triggerKind === plugin_api_rpc_1.DebugConfigurationProviderTriggerKind.Dynamic &&
            p.provideDebugConfigurations));
        const configurationsRecord = {};
        await Promise.all(pluginProviders.map(async (provider) => {
            const configurations = await provider.provideDebugConfigurations(folder);
            let configurationsPerType = configurationsRecord[provider.type];
            configurationsPerType = configurationsPerType ? configurationsPerType.concat(configurations) : configurations;
            if (configurationsPerType.length > 0) {
                configurationsRecord[provider.type] = configurationsPerType;
            }
        }));
        return configurationsRecord;
    }
    /**
     * Provides dynamic debug configurations for a specific provider type only.
     * This is more efficient than provideDynamicDebugConfigurations when you only
     * need configurations for a single type.
     */
    async provideDynamicDebugConfigurationsByType(type, folder) {
        const pluginProviders = Array.from(this.configurationProviders.values()).filter(p => (p.triggerKind === plugin_api_rpc_1.DebugConfigurationProviderTriggerKind.Dynamic &&
            p.type === type &&
            p.provideDebugConfigurations));
        const allConfigurations = [];
        await Promise.all(pluginProviders.map(async (provider) => {
            const configurations = await provider.provideDebugConfigurations(folder);
            if (configurations) {
                allConfigurations.push(...configurations);
            }
        }));
        return allConfigurations;
    }
    async resolveDebugConfiguration(config, workspaceFolderUri) {
        const allProviders = Array.from(this.configurationProviders.values());
        const resolvers = allProviders
            .filter(p => p.type === config.type && !!p.resolveDebugConfiguration)
            .map(p => p.resolveDebugConfiguration);
        // Append debug type '*' at the end
        resolvers.push(...allProviders
            .filter(p => p.type === '*' && !!p.resolveDebugConfiguration)
            .map(p => p.resolveDebugConfiguration));
        const resolved = await this.resolveDebugConfigurationByResolversChain(config, workspaceFolderUri, resolvers);
        return resolved ? this.delegated.resolveDebugConfiguration(resolved, workspaceFolderUri) : resolved;
    }
    async resolveDebugConfigurationWithSubstitutedVariables(config, workspaceFolderUri) {
        const allProviders = Array.from(this.configurationProviders.values());
        const resolvers = allProviders
            .filter(p => p.type === config.type && !!p.resolveDebugConfigurationWithSubstitutedVariables)
            .map(p => p.resolveDebugConfigurationWithSubstitutedVariables);
        // Append debug type '*' at the end
        resolvers.push(...allProviders
            .filter(p => p.type === '*' && !!p.resolveDebugConfigurationWithSubstitutedVariables)
            .map(p => p.resolveDebugConfigurationWithSubstitutedVariables));
        const resolved = await this.resolveDebugConfigurationByResolversChain(config, workspaceFolderUri, resolvers);
        return resolved
            ? this.delegated.resolveDebugConfigurationWithSubstitutedVariables(resolved, workspaceFolderUri)
            : resolved;
    }
    async resolveDebugConfigurationByResolversChain(config, workspaceFolderUri, resolvers) {
        let resolved = config;
        for (const resolver of resolvers) {
            try {
                if (!resolved) {
                    // A provider has indicated to stop and process undefined or null as per specified in the vscode API
                    // https://code.visualstudio.com/api/references/vscode-api#DebugConfigurationProvider
                    break;
                }
                resolved = await resolver(workspaceFolderUri, resolved);
            }
            catch (e) {
                this.logger.error(e);
            }
        }
        return resolved;
    }
    registerDebugger(contribution) {
        this.debuggers.push(contribution);
        return disposable_1.Disposable.create(() => {
            const index = this.debuggers.indexOf(contribution);
            if (index !== -1) {
                this.debuggers.splice(index, 1);
            }
        });
    }
    async provideDebuggerVariables(debugType) {
        for (const contribution of this.debuggers) {
            if (contribution.type === debugType) {
                const variables = contribution.variables;
                if (variables && Object.keys(variables).length > 0) {
                    return variables;
                }
            }
        }
        return {};
    }
    async getDebuggersForLanguage(language) {
        const debuggers = await this.delegated.getDebuggersForLanguage(language);
        for (const contributor of this.debuggers) {
            const languages = contributor.languages;
            if (languages && languages.indexOf(language) !== -1) {
                const { label, type } = contributor;
                debuggers.push({ type, label: label || type });
            }
        }
        return debuggers;
    }
    async getSchemaAttributes(debugType) {
        let schemas = await this.delegated.getSchemaAttributes(debugType);
        for (const contribution of this.debuggers) {
            if (contribution.configurationAttributes &&
                (contribution.type === debugType || contribution.type === '*' || debugType === '*')) {
                schemas = schemas.concat(this.resolveSchemaAttributes(contribution.type, contribution.configurationAttributes));
            }
        }
        return schemas;
    }
    resolveSchemaAttributes(type, configurationAttributes) {
        const taskSchema = {};
        return Object.keys(configurationAttributes).map(request => {
            const attributes = (0, core_1.deepClone)(configurationAttributes[request]);
            const defaultRequired = ['name', 'type', 'request'];
            attributes.required = attributes.required && attributes.required.length ? defaultRequired.concat(attributes.required) : defaultRequired;
            attributes.additionalProperties = false;
            attributes.type = 'object';
            if (!attributes.properties) {
                attributes.properties = {};
            }
            const properties = attributes.properties;
            properties['type'] = {
                enum: [type],
                description: core_1.nls.localizeByDefault('Type of configuration.'),
                pattern: '^(?!node2)',
                errorMessage: core_1.nls.localizeByDefault('The debug type is not recognized. Make sure that you have a corresponding debug extension installed and that it is enabled.'),
                patternErrorMessage: core_1.nls.localizeByDefault('"node2" is no longer supported, use "node" instead and set the "protocol" attribute to "inspector".')
            };
            properties['name'] = {
                type: 'string',
                description: core_1.nls.localizeByDefault('Name of configuration; appears in the launch configuration dropdown menu.'),
                default: 'Launch'
            };
            properties['request'] = {
                enum: [request],
                description: core_1.nls.localizeByDefault('Request type of configuration. Can be "launch" or "attach".'),
            };
            properties['debugServer'] = {
                type: 'number',
                description: core_1.nls.localizeByDefault('For debug extension development only: if a port is specified VS Code tries to connect to a debug adapter running in server mode'),
                default: 4711
            };
            properties['preLaunchTask'] = {
                anyOf: [taskSchema, {
                        type: ['string'],
                    }],
                default: '',
                description: core_1.nls.localizeByDefault('Task to run before debug session starts.')
            };
            properties['postDebugTask'] = {
                anyOf: [taskSchema, {
                        type: ['string'],
                    }],
                default: '',
                description: core_1.nls.localizeByDefault('Task to run after debug session ends.')
            };
            properties['internalConsoleOptions'] = {
                enum: ['neverOpen', 'openOnSessionStart', 'openOnFirstSessionStart'],
                default: 'openOnFirstSessionStart',
                description: core_1.nls.localizeByDefault('Controls when the internal Debug Console should open.')
            };
            properties['suppressMultipleSessionWarning'] = {
                type: 'boolean',
                description: core_1.nls.localizeByDefault('Disable the warning when trying to start the same debug configuration more than once.'),
                default: true
            };
            const osProperties = Object.assign({}, properties);
            properties['windows'] = {
                type: 'object',
                description: core_1.nls.localizeByDefault('Windows specific launch configuration attributes.'),
                properties: osProperties
            };
            properties['osx'] = {
                type: 'object',
                description: core_1.nls.localizeByDefault('OS X specific launch configuration attributes.'),
                properties: osProperties
            };
            properties['linux'] = {
                type: 'object',
                description: core_1.nls.localizeByDefault('Linux specific launch configuration attributes.'),
                properties: osProperties
            };
            Object.keys(attributes.properties).forEach(name => {
                // Use schema allOf property to get independent error reporting #21113
                attributes.properties[name].pattern = attributes.properties[name].pattern || '^(?!.*\\$\\{(env|config|command)\\.)';
                attributes.properties[name].patternErrorMessage = attributes.properties[name].patternErrorMessage ||
                    core_1.nls.localizeByDefault("'env.', 'config.' and 'command.' are deprecated, use 'env:', 'config:' and 'command:' instead.");
            });
            return attributes;
        });
    }
    async getConfigurationSnippets() {
        let snippets = await this.delegated.getConfigurationSnippets();
        for (const contribution of this.debuggers) {
            if (contribution.configurationSnippets) {
                snippets = snippets.concat(contribution.configurationSnippets);
            }
        }
        return snippets;
    }
    async createDebugSession(config, workspaceFolder) {
        const contributor = this.contributors.get(config.type);
        if (contributor) {
            const sessionId = await contributor.createDebugSession(config, workspaceFolder);
            this.sessionId2contrib.set(sessionId, contributor);
            return sessionId;
        }
        else {
            return this.delegated.createDebugSession(config, workspaceFolder);
        }
    }
    async terminateDebugSession(sessionId) {
        const contributor = this.sessionId2contrib.get(sessionId);
        if (contributor) {
            this.sessionId2contrib.delete(sessionId);
            return contributor.terminateDebugSession(sessionId);
        }
        else {
            return this.delegated.terminateDebugSession(sessionId);
        }
    }
    dispose() {
        this.toDispose.dispose();
    }
};
exports.PluginDebugService = PluginDebugService;
tslib_1.__decorate([
    (0, inversify_1.inject)(ws_connection_provider_1.WebSocketConnectionProvider),
    tslib_1.__metadata("design:type", ws_connection_provider_1.WebSocketConnectionProvider)
], PluginDebugService.prototype, "connectionProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.WorkspaceService),
    tslib_1.__metadata("design:type", browser_1.WorkspaceService)
], PluginDebugService.prototype, "workspaceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('plugin-ext:PluginDebugService'),
    tslib_1.__metadata("design:type", Object)
], PluginDebugService.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], PluginDebugService.prototype, "init", null);
exports.PluginDebugService = PluginDebugService = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], PluginDebugService);
//# sourceMappingURL=plugin-debug-service.js.map