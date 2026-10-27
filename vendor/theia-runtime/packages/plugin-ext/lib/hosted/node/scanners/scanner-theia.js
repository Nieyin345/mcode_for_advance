"use strict";
// *****************************************************************************
// Copyright (C) 2015-2021 Red Hat, Inc.
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
exports.TheiaPluginScanner = exports.AbstractPluginScanner = void 0;
const tslib_1 = require("tslib");
/* eslint-disable @theia/localization-check */
const inversify_1 = require("@theia/core/shared/inversify");
const plugin_protocol_1 = require("../../../common/plugin-protocol");
const fs_1 = require("fs");
const path = require("path");
const jsoncparser = require("jsonc-parser");
const grammars_reader_1 = require("./grammars-reader");
const utils_1 = require("@theia/plugin-utils/lib/common/utils");
const plugin_uri_factory_1 = require("./plugin-uri-factory");
const core_1 = require("@theia/core");
const node_async_hooks_1 = require("node:async_hooks");
const normalize_contributions_1 = require("@theia/plugin-utils/lib/node/normalize-contributions");
const plugin_model_1 = require("@theia/plugin-utils/lib/common/plugin-model");
const plugin_model_2 = require("@theia/plugin-utils/lib/node/plugin-model");
/** Async-local contribution ctx — safe for concurrent scans on the singleton scanner. */
const contributionCtxStorage = new node_async_hooks_1.AsyncLocalStorage();
let AbstractPluginScanner = class AbstractPluginScanner {
    constructor(_apiType, _backendInitPath) {
        this._apiType = _apiType;
        this._backendInitPath = _backendInitPath;
    }
    get apiType() {
        return this._apiType;
    }
    getModel(plugin) {
        const publisher = plugin.publisher ?? plugin_protocol_1.PluginIdentifiers.UNPUBLISHED;
        const result = (0, plugin_model_1.buildModelForTheia)({
            ...plugin,
            publisher,
            packageUri: this.pluginUriFactory.createUri(plugin).toString(),
        });
        result.engine.type = this._apiType;
        result.engine.version = plugin.engines[this._apiType] ?? '*';
        result.entryPoint = this.getEntryPoint(plugin);
        result.licenseUrl = this.getLicenseUrl(plugin);
        result.readmeUrl = this.getReadmeUrl(plugin);
        this.applyTrustExtraction(plugin, result);
        return result;
    }
    applyTrustExtraction(plugin, result) {
        (0, plugin_model_1.applyTrustExtraction)(plugin, result);
    }
    getReadmeUrl(plugin) {
        return this.getPluginRootFileUrl(plugin, ['readme.md', 'readme.txt', 'readme']);
    }
    getLicenseUrl(plugin) {
        return this.getPluginRootFileUrl(plugin, ['license', 'license.txt', 'license.md']);
    }
    getPluginRootFileUrl(plugin, names) {
        return (0, plugin_model_2.getPluginRootFileUrl)(plugin, names);
    }
    getLifecycle(plugin) {
        const result = (0, plugin_model_1.buildLifecycle)(plugin, 'theiaPlugin');
        if (this._backendInitPath) {
            result.backendInitPath = path.join(__dirname, this._backendInitPath);
        }
        return result;
    }
    getDependencies(rawPlugin) {
        // skip it since there is no way to load transitive dependencies for Theia plugins yet
        return undefined;
    }
    async getContribution(rawPlugin) {
        if (!rawPlugin.contributes && !rawPlugin.activationEvents) {
            return undefined;
        }
        const contributions = {
            activationEvents: rawPlugin.activationEvents
        };
        if (!rawPlugin.contributes) {
            return contributions;
        }
        return this.readContributions(rawPlugin, contributions);
    }
    async readContributions(rawPlugin, contributions) {
        return contributions;
    }
};
exports.AbstractPluginScanner = AbstractPluginScanner;
tslib_1.__decorate([
    (0, inversify_1.inject)(grammars_reader_1.GrammarsReader),
    tslib_1.__metadata("design:type", grammars_reader_1.GrammarsReader)
], AbstractPluginScanner.prototype, "grammarsReader", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(plugin_uri_factory_1.PluginUriFactory),
    tslib_1.__metadata("design:type", Object)
], AbstractPluginScanner.prototype, "pluginUriFactory", void 0);
exports.AbstractPluginScanner = AbstractPluginScanner = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__param(0, (0, inversify_1.unmanaged)()),
    tslib_1.__param(1, (0, inversify_1.unmanaged)()),
    tslib_1.__metadata("design:paramtypes", [String, String])
], AbstractPluginScanner);
let TheiaPluginScanner = class TheiaPluginScanner extends AbstractPluginScanner {
    constructor() {
        super('theiaPlugin', 'backend-init-theia');
    }
    getEntryPoint(plugin) {
        return (0, plugin_model_1.buildEntryPointForTheia)(plugin);
    }
    static getScope(monacoScope) {
        return (0, normalize_contributions_1.getScope)(monacoScope);
    }
    async readContributions(rawPlugin, contributions) {
        const ctx = this.contributionCtx(rawPlugin);
        return contributionCtxStorage.run(ctx, () => (0, normalize_contributions_1.normalizeContributions)(ctx, contributions));
    }
    contributionCtx(pck) {
        const active = contributionCtxStorage.getStore();
        if (active?.plugin === pck) {
            return active;
        }
        const ctx = {
            plugin: pck,
            resolveUrl: relativePath => this.toPluginUrl(pck, relativePath),
            resolveUri: (_plugin, relativePath) => this.pluginUriFactory.createUri(pck, relativePath).toString(),
            onError: (type, err, detail) => this.logger.error(`Could not read '${pck.name}' contribution '${type}'.`, detail, err),
            onWarn: msg => this.logger.warn(msg),
            readJsonFile: filePath => this.readJson(filePath),
            // Route through protected methods so Inversify/subclass overrides still apply.
            transformIconUrl: (plugin, original) => this.transformIconUrl(plugin, original),
            readLocalization: (entry, pluginPath) => this.readLocalization(entry, pluginPath),
            readTranslation: (entry, pluginPath) => this.readTranslation(entry, pluginPath),
            toSchema: definition => this.toSchema(definition),
            readConfiguration: this.readConfiguration.bind(this),
            readCustomEditors: this.readCustomEditors.bind(this),
            readViews: this.readViews.bind(this),
            readKeybinding: this.readKeybinding.bind(this),
            readDebuggers: this.readDebuggers.bind(this),
            readSubmenus: (submenus, plugin) => this.readSubmenus(submenus, plugin),
            readViewsContainers: (containers, plugin) => this.readViewsContainers(containers, plugin),
            readViewsWelcome: (welcome, views) => this.readViewsWelcome(welcome, views),
            readCommand: (command, plugin) => this.readCommand(command, plugin),
            readMenus: menus => this.readMenus(menus),
            readTaskDefinition: (pluginName, definition) => this.readTaskDefinition(pluginName, definition),
            readSnippets: plugin => this.readSnippets(plugin),
            readThemes: plugin => this.readThemes(plugin),
            readIcons: plugin => this.readIcons(plugin),
            readIconThemes: plugin => this.readIconThemes(plugin),
            readColors: plugin => this.readColors(plugin),
            readTerminals: plugin => this.readTerminals(plugin),
            readLocalizations: plugin => this.readLocalizations(plugin),
            readWalkthroughs: plugin => this.readWalkthroughs(plugin),
            readLanguages: (languages, plugin) => this.readLanguages(languages, plugin),
        };
        ctx.readGrammars = (grammars, pluginPath) => this.grammarsReader.readGrammars(grammars, pluginPath, ctx);
        return ctx;
    }
    readTerminals(pck) {
        return (0, normalize_contributions_1.readTerminals)(pck);
    }
    readLocalizations(pck) {
        return (0, normalize_contributions_1.readLocalizations)(pck, this.contributionCtx(pck));
    }
    readLocalization(entry, pluginPath) {
        return (0, normalize_contributions_1.readLocalization)(entry, pluginPath, {
            readTranslation: (translation, translationPath) => this.readTranslation(translation, translationPath),
        });
    }
    readTranslation(packageTranslation, pluginPath) {
        return (0, normalize_contributions_1.readTranslation)(packageTranslation, pluginPath);
    }
    readWalkthroughs(pck) {
        return (0, normalize_contributions_1.readWalkthroughs)(pck, this.contributionCtx(pck));
    }
    readCommand(command, pck) {
        return (0, normalize_contributions_1.readCommand)(this.contributionCtx(pck), command, pck);
    }
    transformIconUrl(plugin, original) {
        return (0, normalize_contributions_1.transformIconUrl)(this.contributionCtx(plugin), plugin, original);
    }
    toPluginUrl(pck, relativePath) {
        return (0, plugin_model_1.toPluginUrl)(pck, relativePath);
    }
    readColors(pck) {
        return (0, normalize_contributions_1.readColors)(this.contributionCtx(pck), pck);
    }
    readThemes(pck) {
        return (0, normalize_contributions_1.readThemes)(this.contributionCtx(pck), pck);
    }
    readIconThemes(pck) {
        return (0, normalize_contributions_1.readIconThemes)(this.contributionCtx(pck), pck);
    }
    readIcons(pck) {
        return (0, normalize_contributions_1.readIcons)(this.contributionCtx(pck), pck);
    }
    readSnippets(pck) {
        return (0, normalize_contributions_1.readSnippets)(this.contributionCtx(pck), pck);
    }
    readConfiguration(rawConfiguration, pluginPath) {
        return (0, normalize_contributions_1.readConfiguration)(rawConfiguration, pluginPath);
    }
    readKeybinding(rawKeybinding) {
        return (0, normalize_contributions_1.readKeybinding)(rawKeybinding);
    }
    readCustomEditors(rawCustomEditors) {
        return rawCustomEditors.map(rawCustomEditor => this.readCustomEditor(rawCustomEditor));
    }
    readCustomEditor(rawCustomEditor) {
        return (0, normalize_contributions_1.readCustomEditor)(rawCustomEditor);
    }
    readViewsContainers(rawViewsContainers, pck) {
        return rawViewsContainers
            .map(rawViewContainer => this.readViewContainer(rawViewContainer, pck))
            .filter((container) => container !== undefined);
    }
    readViewContainer(rawViewContainer, pck) {
        return (0, normalize_contributions_1.readViewContainer)(this.contributionCtx(pck), rawViewContainer, pck);
    }
    readViews(rawViews) {
        return rawViews.map(rawView => this.readView(rawView));
    }
    readView(rawView) {
        return (0, normalize_contributions_1.readView)(rawView);
    }
    readViewsWelcome(rawViewsWelcome, rowViews) {
        return rawViewsWelcome.map(rawViewWelcome => this.readViewWelcome(rawViewWelcome, this.extractPluginViewsIds(rowViews)));
    }
    readViewWelcome(rawViewWelcome, pluginViewsIds) {
        return (0, normalize_contributions_1.readViewWelcome)(rawViewWelcome, pluginViewsIds);
    }
    extractPluginViewsIds(views) {
        return (0, normalize_contributions_1.extractPluginViewsIds)(views);
    }
    readMenus(rawMenus) {
        return rawMenus.map(rawMenu => this.readMenu(rawMenu));
    }
    readMenu(rawMenu) {
        return (0, normalize_contributions_1.readMenu)(rawMenu);
    }
    async readLanguages(rawLanguages, plugin) {
        return Promise.all(rawLanguages.map(language => this.readLanguage(language, plugin)));
    }
    readSubmenus(rawSubmenus, plugin) {
        return rawSubmenus.map(submenu => this.readSubmenu(submenu, plugin));
    }
    readSubmenu(rawSubmenu, plugin) {
        return (0, normalize_contributions_1.readSubmenu)(this.contributionCtx(plugin), rawSubmenu, plugin);
    }
    async readLanguage(rawLang, plugin) {
        return (0, normalize_contributions_1.readLanguage)(this.contributionCtx(plugin), rawLang, plugin);
    }
    readDebuggers(rawDebuggers) {
        return rawDebuggers.map(rawDebugger => this.readDebugger(rawDebugger));
    }
    readDebugger(rawDebugger) {
        return (0, normalize_contributions_1.readDebugger)(rawDebugger);
    }
    readTaskDefinition(pluginName, definitionContribution) {
        return (0, normalize_contributions_1.readTaskDefinition)(pluginName, definitionContribution, {
            toSchema: definition => this.toSchema(definition)
        });
    }
    toSchema(definition) {
        return (0, normalize_contributions_1.toSchema)(definition);
    }
    async readJson(filePath) {
        const content = await this.readFile(filePath);
        return content ? jsoncparser.parse(content, undefined, { disallowComments: false }) : undefined;
    }
    async readFile(filePath) {
        try {
            const content = await fs_1.promises.readFile(filePath, { encoding: 'utf8' });
            return content;
        }
        catch (e) {
            if (!(0, utils_1.isENOENT)(e)) {
                this.logger.error(e);
            }
            return '';
        }
    }
};
exports.TheiaPluginScanner = TheiaPluginScanner;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('plugin-ext:TheiaPluginScanner'),
    tslib_1.__metadata("design:type", Object)
], TheiaPluginScanner.prototype, "logger", void 0);
exports.TheiaPluginScanner = TheiaPluginScanner = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__metadata("design:paramtypes", [])
], TheiaPluginScanner);
//# sourceMappingURL=scanner-theia.js.map