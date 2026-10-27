"use strict";
// *****************************************************************************
// Copyright (C) 2026 Maksim Kachurin and others.
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
const chai_1 = require("chai");
const contribution_types_1 = require("../common/contribution-types");
const protocol_shims_1 = require("../common/protocol-shims");
const normalize_contributions_1 = require("./normalize-contributions");
const test_helpers_1 = require("../common/test-helpers");
describe('normalize-contributions', () => {
    describe('deriveDefaultForType', () => {
        it('mirrors VS Code defaults for each json type', () => {
            (0, chai_1.expect)((0, normalize_contributions_1.deriveDefaultForType)('boolean')).to.equal(false);
            (0, chai_1.expect)((0, normalize_contributions_1.deriveDefaultForType)('integer')).to.equal(0);
            (0, chai_1.expect)((0, normalize_contributions_1.deriveDefaultForType)('number')).to.equal(0);
            (0, chai_1.expect)((0, normalize_contributions_1.deriveDefaultForType)('string')).to.equal('');
            (0, chai_1.expect)((0, normalize_contributions_1.deriveDefaultForType)('array')).to.deep.equal([]);
            (0, chai_1.expect)((0, normalize_contributions_1.deriveDefaultForType)('object')).to.deep.equal({});
            // eslint-disable-next-line no-null/no-null
            (0, chai_1.expect)((0, normalize_contributions_1.deriveDefaultForType)(undefined)).to.equal(null);
        });
        it('uses the first type when an array is provided', () => {
            (0, chai_1.expect)((0, normalize_contributions_1.deriveDefaultForType)(['string', 'number'])).to.equal('');
        });
    });
    describe('getScope', () => {
        it('maps monaco scopes to preference scope and overridable flag', () => {
            (0, chai_1.expect)((0, normalize_contributions_1.getScope)('machine-overridable')).to.deep.equal({ scope: protocol_shims_1.PreferenceScope.Folder, overridable: false });
            (0, chai_1.expect)((0, normalize_contributions_1.getScope)('language-overridable')).to.deep.equal({ scope: protocol_shims_1.PreferenceScope.Folder, overridable: true });
            (0, chai_1.expect)((0, normalize_contributions_1.getScope)('application')).to.deep.equal({ scope: protocol_shims_1.PreferenceScope.User, overridable: false });
            (0, chai_1.expect)((0, normalize_contributions_1.getScope)(undefined)).to.deep.equal({ scope: undefined, overridable: false });
        });
    });
    describe('readConfiguration', () => {
        it('derives defaults and property scopes', () => {
            const schema = (0, normalize_contributions_1.readConfiguration)({
                title: 'Sample',
                scope: 'application',
                properties: {
                    'sample.enabled': { type: 'boolean', scope: 'language-overridable' },
                    'sample.path': { type: 'string', default: '/tmp' }
                }
            }, '/tmp/plugin');
            (0, chai_1.expect)(schema?.scope).to.equal(protocol_shims_1.PreferenceScope.User);
            (0, chai_1.expect)(schema?.properties['sample.enabled'].default).to.equal(false);
            (0, chai_1.expect)(schema?.properties['sample.enabled'].overridable).to.equal(true);
            (0, chai_1.expect)(schema?.properties['sample.path'].default).to.equal('/tmp');
        });
    });
    describe('transformIconUrl and readCommand', () => {
        it('resolves file icons and codicons', () => {
            const ctx = (0, test_helpers_1.createNormalizeCtx)();
            (0, chai_1.expect)((0, normalize_contributions_1.transformIconUrl)(ctx, ctx.plugin, './media/icon.png')).to.deep.equal({
                iconUrl: 'hostedPlugin/acme_test_ext/media/icon.png'
            });
            (0, chai_1.expect)((0, normalize_contributions_1.transformIconUrl)(ctx, ctx.plugin, '$(zap)')).to.deep.equal({ themeIcon: '$(zap)' });
            (0, chai_1.expect)((0, normalize_contributions_1.transformIconUrl)(ctx, ctx.plugin, {
                light: './light.png',
                dark: './dark.png'
            })).to.deep.equal({
                iconUrl: {
                    light: 'hostedPlugin/acme_test_ext/light.png',
                    dark: 'hostedPlugin/acme_test_ext/dark.png'
                }
            });
            const command = (0, normalize_contributions_1.readCommand)(ctx, {
                command: 'sample.run',
                title: 'Run',
                original: 'Original',
                icon: '$(play)'
            }, ctx.plugin);
            (0, chai_1.expect)(command).to.include({
                command: 'sample.run',
                title: 'Run',
                originalTitle: 'Original',
                themeIcon: '$(play)'
            });
        });
        it('honors ctx.transformIconUrl from readCommand / readSubmenu', () => {
            const ctx = (0, test_helpers_1.createNormalizeCtx)();
            ctx.transformIconUrl = () => ({ themeIcon: '$(custom)' });
            (0, chai_1.expect)((0, normalize_contributions_1.readCommand)(ctx, {
                command: 'sample.run',
                title: 'Run',
                icon: '$(play)'
            }, ctx.plugin).themeIcon).to.equal('$(custom)');
            (0, chai_1.expect)((0, normalize_contributions_1.readSubmenus)(ctx, [{
                    id: 'sample.submenu',
                    label: 'Sample',
                    icon: './icon.png'
                }], ctx.plugin)[0].icon).to.equal('$(custom)');
        });
    });
    describe('readKeybinding and menus', () => {
        it('copies keybinding fields', () => {
            (0, chai_1.expect)((0, normalize_contributions_1.readKeybinding)({
                key: 'ctrl+shift+p',
                command: 'sample.run',
                when: 'editorFocus',
                mac: 'cmd+shift+p'
            })).to.deep.equal({
                keybinding: 'ctrl+shift+p',
                command: 'sample.run',
                when: 'editorFocus',
                mac: 'cmd+shift+p',
                linux: undefined,
                win: undefined,
                args: undefined
            });
        });
        it('copies menu fields', () => {
            (0, chai_1.expect)((0, normalize_contributions_1.readMenus)([{
                    command: 'sample.run',
                    group: 'navigation',
                    when: 'true'
                }])).to.deep.equal([{
                    command: 'sample.run',
                    group: 'navigation',
                    when: 'true',
                    submenu: undefined,
                    alt: undefined
                }]);
        });
    });
    describe('views', () => {
        it('extracts view ids across locations', () => {
            (0, chai_1.expect)((0, normalize_contributions_1.extractPluginViewsIds)({
                explorer: [{ id: 'a', name: 'A' }],
                panel: [{ id: 'b', name: 'B' }]
            })).to.deep.equal(['a', 'b']);
        });
        it('normalizes view containers, views, and welcome content order', () => {
            const ctx = (0, test_helpers_1.createNormalizeCtx)();
            const containers = (0, normalize_contributions_1.readViewsContainers)(ctx, [{
                    id: 'sample.container',
                    title: 'Sample',
                    icon: '$(folder)'
                }], ctx.plugin);
            (0, chai_1.expect)(containers[0]).to.include({
                id: 'sample.container',
                themeIcon: '$(folder)'
            });
            (0, chai_1.expect)(containers[0].iconUrl).to.equal('hostedPlugin/acme_test_ext/%24(folder)');
            const views = (0, normalize_contributions_1.readViews)([{ id: 'sample.view', name: 'Sample View' }]);
            (0, chai_1.expect)(views).to.deep.equal([{
                    id: 'sample.view',
                    name: 'Sample View',
                    when: undefined,
                    type: undefined
                }]);
            const welcome = (0, normalize_contributions_1.readViewsWelcome)([{
                    view: 'sample.view',
                    contents: 'Welcome'
                }], { explorer: [{ id: 'sample.view', name: 'Sample View' }] });
            (0, chai_1.expect)(welcome[0].order).to.equal(0);
            (0, chai_1.expect)((0, normalize_contributions_1.readViewWelcome)({
                view: 'missing.view',
                contents: 'Missing'
            }, ['sample.view']).order).to.equal(1);
        });
        it('skips view containers without a string icon and reports an error', () => {
            const errors = [];
            const ctx = (0, test_helpers_1.createNormalizeCtx)({}, {
                onError: (_kind, message) => {
                    errors.push(message);
                }
            });
            (0, chai_1.expect)((0, normalize_contributions_1.readViewContainer)(ctx, {
                id: 'sample.container',
                title: 'Sample'
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
            }, ctx.plugin)).to.equal(undefined);
            (0, chai_1.expect)((0, normalize_contributions_1.readViewsContainers)(ctx, [{
                    id: 'valid.container',
                    title: 'Valid',
                    icon: '$(folder)'
                }, {
                    id: 'invalid.container',
                    title: 'Invalid'
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                }], ctx.plugin)).to.have.lengthOf(1);
            (0, chai_1.expect)(errors.length).to.be.greaterThan(0);
        });
    });
    describe('custom editors and debuggers', () => {
        it('normalizes custom editors with default priority', () => {
            (0, chai_1.expect)((0, normalize_contributions_1.readCustomEditors)([{
                    viewType: 'sample.editor',
                    displayName: 'Editor'
                }])).to.deep.equal([{
                    viewType: 'sample.editor',
                    displayName: 'Editor',
                    selector: [],
                    priority: contribution_types_1.CustomEditorPriority.default
                }]);
        });
        it('copies debugger contributions', () => {
            (0, chai_1.expect)((0, normalize_contributions_1.readDebuggers)([{
                    type: 'node',
                    label: 'Node Debug',
                    program: './out/debug.js',
                    configurationAttributes: {},
                    configurationSnippets: []
                }])).to.deep.equal([{
                    type: 'node',
                    label: 'Node Debug',
                    program: './out/debug.js',
                    languages: undefined,
                    enableBreakpointsFor: undefined,
                    variables: undefined,
                    adapterExecutableCommand: undefined,
                    configurationSnippets: [],
                    win: undefined,
                    winx86: undefined,
                    windows: undefined,
                    osx: undefined,
                    linux: undefined,
                    args: undefined,
                    runtime: undefined,
                    runtimeArgs: undefined,
                    configurationAttributes: {}
                }]);
        });
    });
    describe('themes, snippets, icon themes, and colors', () => {
        it('resolves theme and snippet uris', () => {
            const ctx = (0, test_helpers_1.createNormalizeCtx)(undefined, undefined);
            const plugin = (0, test_helpers_1.manifest)({
                name: 'themes',
                contributes: {
                    themes: [{ id: 'dark', label: 'Dark', path: './themes/dark.json' }],
                    snippets: [{ language: 'typescript', path: './snippets/ts.json' }],
                    iconThemes: [{ id: 'set', label: 'Set', path: './icons/theme.json' }]
                }
            });
            ctx.plugin = plugin;
            (0, chai_1.expect)((0, normalize_contributions_1.readThemes)(ctx, plugin)).to.deep.equal([{
                    id: 'dark',
                    label: 'Dark',
                    uri: 'hostedPlugin/acme_themes/themes/dark.json',
                    description: undefined,
                    uiTheme: undefined
                }]);
            (0, chai_1.expect)((0, normalize_contributions_1.readSnippets)(ctx, plugin)).to.deep.equal([{
                    language: 'typescript',
                    source: 'Test Extension',
                    uri: 'hostedPlugin/acme_themes/snippets/ts.json'
                }]);
            (0, chai_1.expect)((0, normalize_contributions_1.readIconThemes)(ctx, plugin)).to.deep.equal([{
                    id: 'set',
                    label: 'Set',
                    uri: 'hostedPlugin/acme_themes/icons/theme.json',
                    description: undefined,
                    uiTheme: undefined
                }]);
        });
        // A `uiTheme` that does not survive normalization falls back to `vs-dark` in the frontend, which
        // files the theme under the dark ones and resolves its colors through the dark path.
        it('keeps every ui theme, including hc-light', () => {
            const ctx = (0, test_helpers_1.createNormalizeCtx)(undefined, undefined);
            const plugin = (0, test_helpers_1.manifest)({
                name: 'themes',
                contributes: {
                    themes: [
                        { id: 'light', label: 'Light', uiTheme: 'vs', path: './themes/light.json' },
                        { id: 'dark', label: 'Dark', uiTheme: 'vs-dark', path: './themes/dark.json' },
                        { id: 'hc', label: 'HC', uiTheme: 'hc-black', path: './themes/hc.json' },
                        { id: 'hc-light', label: 'HC Light', uiTheme: 'hc-light', path: './themes/hc-light.json' },
                        // Manifests are untyped JSON, so an unknown value has to be dropped rather than passed on.
                        { id: 'bogus', label: 'Bogus', uiTheme: 'nonsense', path: './themes/bogus.json' }
                    ]
                }
            });
            ctx.plugin = plugin;
            (0, chai_1.expect)((0, normalize_contributions_1.readThemes)(ctx, plugin)?.map(theme => theme.uiTheme))
                .to.deep.equal(['vs', 'vs-dark', 'hc-black', 'hc-light', undefined]);
        });
        it('validates color contributions and reports invalid ids', () => {
            const warnings = [];
            const ctx = (0, test_helpers_1.createNormalizeCtx)({ name: 'colors' }, {
                onWarn: message => {
                    warnings.push(message);
                }
            });
            const plugin = (0, test_helpers_1.manifest)({
                name: 'colors',
                contributes: {
                    colors: [
                        {
                            id: 'valid.color',
                            description: 'Valid',
                            defaults: { light: '#fff', dark: '#000', highContrast: '#111' }
                        },
                        { id: 'bad id', description: 'Bad', defaults: { light: '#fff', dark: '#000', highContrast: '#111' } }
                    ]
                }
            });
            ctx.plugin = plugin;
            const colors = (0, normalize_contributions_1.readColors)(ctx, plugin);
            (0, chai_1.expect)(colors).to.have.lengthOf(1);
            (0, chai_1.expect)(colors[0].defaults).to.deep.equal({ light: '#fff', dark: '#000', hc: '#111' });
            (0, chai_1.expect)(warnings.some(message => message.includes('word[.word]*'))).to.equal(true);
        });
        it('rejects color contributions with empty descriptions', () => {
            const warnings = [];
            const ctx = (0, test_helpers_1.createNormalizeCtx)({ name: 'colors' }, {
                onWarn: message => {
                    warnings.push(message);
                }
            });
            const plugin = (0, test_helpers_1.manifest)({
                name: 'colors',
                contributes: {
                    colors: [{
                            id: 'valid.color',
                            description: '',
                            defaults: { light: '#fff', dark: '#000', highContrast: '#111' }
                        }]
                }
            });
            ctx.plugin = plugin;
            (0, chai_1.expect)((0, normalize_contributions_1.readColors)(ctx, plugin)).to.deep.equal([]);
            (0, chai_1.expect)(warnings.some(message => message.includes('description'))).to.equal(true);
        });
    });
    describe('icons', () => {
        it('accepts icon references and font-based defaults', () => {
            const ctx = (0, test_helpers_1.createNormalizeCtx)({ name: 'icons', publisher: 'acme' });
            const plugin = (0, test_helpers_1.manifest)({
                name: 'icons',
                publisher: 'acme',
                contributes: {
                    icons: {
                        'sample-icon': {
                            description: 'Sample icon',
                            default: 'other-icon'
                        },
                        'font-icon': {
                            description: 'Font icon',
                            default: {
                                fontPath: './media/icon.woff2',
                                fontCharacter: '\\E001'
                            }
                        }
                    }
                }
            });
            ctx.plugin = plugin;
            const icons = (0, normalize_contributions_1.readIcons)(ctx, plugin);
            (0, chai_1.expect)(icons).to.deep.equal([
                {
                    id: 'sample-icon',
                    extensionId: 'acme.icons',
                    description: 'Sample icon',
                    defaults: { id: 'other-icon' }
                },
                {
                    id: 'font-icon',
                    extensionId: 'acme.icons',
                    description: 'Font icon',
                    defaults: {
                        fontCharacter: '\\E001',
                        location: 'hostedPlugin/acme_icons/media/icon.woff2'
                    }
                }
            ]);
        });
    });
    describe('terminals, localizations, submenus, and tasks', () => {
        it('reads terminal profiles with required fields only', () => {
            const plugin = (0, test_helpers_1.manifest)({
                name: 'terminal',
                contributes: {
                    terminal: {
                        profiles: [
                            { id: 'bash', title: 'Bash' },
                            { id: 'invalid' },
                            { id: '', title: 'Empty' },
                            { id: 'empty-title', title: '' },
                        ]
                    }
                }
            });
            (0, chai_1.expect)((0, normalize_contributions_1.readTerminals)(plugin)).to.deep.equal([{ id: 'bash', title: 'Bash' }]);
        });
        it('drops empty theme/snippet paths (avoids resolving to the plugin root)', () => {
            const ctx = (0, test_helpers_1.createNormalizeCtx)(undefined, undefined);
            const plugin = (0, test_helpers_1.manifest)({
                name: 'empty-paths',
                contributes: {
                    themes: [{ id: 'bad', path: '' }],
                    snippets: [{ language: 'ts', path: '' }],
                    iconThemes: [{ id: 'bad', path: '' }],
                }
            });
            ctx.plugin = plugin;
            (0, chai_1.expect)((0, normalize_contributions_1.readThemes)(ctx, plugin)).to.deep.equal([]);
            (0, chai_1.expect)((0, normalize_contributions_1.readSnippets)(ctx, plugin)).to.deep.equal([]);
            (0, chai_1.expect)((0, normalize_contributions_1.readIconThemes)(ctx, plugin)).to.deep.equal([]);
        });
        it('reads localization bundles', () => {
            const plugin = (0, test_helpers_1.manifest)({
                name: 'l10n',
                packagePath: '/tmp/plugin',
                contributes: {
                    localizations: [{
                            languageId: 'de',
                            languageName: 'German',
                            translations: [{ id: 'package', path: './package.nls.de.json' }]
                        }]
                }
            });
            (0, chai_1.expect)((0, normalize_contributions_1.readLocalizations)(plugin)).to.deep.equal([{
                    languageId: 'de',
                    languageName: 'German',
                    localizedLanguageName: undefined,
                    minimalTranslations: undefined,
                    translations: [{ id: 'package', path: './package.nls.de.json' }]
                }]);
        });
        it('honors readLocalization / readTranslation ctx hooks', () => {
            const plugin = (0, test_helpers_1.manifest)({
                name: 'l10n',
                packagePath: '/tmp/plugin',
                contributes: {
                    localizations: [{
                            languageId: 'de',
                            translations: [{ id: 'package', path: './package.nls.de.json' }]
                        }]
                }
            });
            const ctx = (0, test_helpers_1.createNormalizeCtx)({ name: 'l10n', packagePath: '/tmp/plugin' });
            ctx.readTranslation = (entry, pluginPath) => ({
                id: entry.id,
                path: `${pluginPath}/${entry.path}`
            });
            ctx.readLocalization = (entry, pluginPath) => (0, normalize_contributions_1.readLocalization)(entry, pluginPath, ctx);
            (0, chai_1.expect)((0, normalize_contributions_1.readLocalizations)(plugin, ctx)).to.deep.equal([{
                    languageId: 'de',
                    languageName: undefined,
                    localizedLanguageName: undefined,
                    minimalTranslations: undefined,
                    translations: [{ id: 'package', path: '/tmp/plugin/./package.nls.de.json' }]
                }]);
        });
        it('reads submenu icons via transformIconUrl', () => {
            const ctx = (0, test_helpers_1.createNormalizeCtx)();
            (0, chai_1.expect)((0, normalize_contributions_1.readSubmenus)(ctx, [{
                    id: 'sample.submenu',
                    label: 'Sample',
                    icon: '$(gear)'
                }], ctx.plugin)).to.deep.equal([{
                    icon: '$(gear)',
                    id: 'sample.submenu',
                    label: 'Sample'
                }]);
        });
        it('builds task definition schema with required type property', () => {
            const definition = (0, normalize_contributions_1.readTaskDefinition)('sample.tasks', {
                type: 'npm',
                required: ['script'],
                properties: {
                    script: { type: 'string' }
                }
            });
            (0, chai_1.expect)(definition.taskType).to.equal('npm');
            (0, chai_1.expect)(definition.source).to.equal('sample.tasks');
            (0, chai_1.expect)(definition.properties.all).to.deep.equal(['script']);
            (0, chai_1.expect)((0, normalize_contributions_1.toSchema)({
                type: 'npm',
                required: [],
                properties: { script: { type: 'string' } }
            }).properties.type).to.deep.equal({ type: 'string', const: 'npm' });
        });
        it('honors ctx.toSchema from readTaskDefinition', () => {
            const customSchema = { type: 'object', properties: { custom: { type: 'boolean' } } };
            const definition = (0, normalize_contributions_1.readTaskDefinition)('sample.tasks', {
                type: 'npm',
                required: [],
                properties: {}
            }, {
                toSchema: () => customSchema
            });
            (0, chai_1.expect)(definition.properties.schema).to.equal(customSchema);
        });
    });
    describe('readLanguage', () => {
        it('loads language configuration from a relative json file', async () => {
            const ctx = (0, test_helpers_1.createNormalizeCtx)({ name: 'lang', packagePath: '/tmp/plugin' }, {
                readJsonFile: async () => ({
                    autoClosingPairs: [['{', '}'], { open: '[', close: ']', notIn: ['string'] }],
                    surroundingPairs: [['(', ')']]
                })
            });
            const languages = await (0, normalize_contributions_1.readLanguages)(ctx, [{
                    id: 'sample',
                    configuration: './language-configuration.json'
                }], ctx.plugin);
            (0, chai_1.expect)(languages[0].configuration?.autoClosingPairs).to.deep.equal([
                { open: '{', close: '}' },
                { open: '[', close: ']', notIn: ['string'] }
            ]);
            (0, chai_1.expect)(languages[0].configuration?.surroundingPairs).to.deep.equal([{ open: '(', close: ')' }]);
        });
    });
    describe('normalizeContributions', () => {
        it('leaves output empty when the manifest has no contribution kinds', async () => {
            const contributions = await (0, normalize_contributions_1.normalizeContributions)((0, test_helpers_1.createNormalizeCtx)({ name: 'empty' }), {});
            (0, chai_1.expect)(Object.keys(contributions)).to.deep.equal([]);
        });
        it('normalizes supported contribution kinds via injectable readers', async () => {
            const ctx = (0, test_helpers_1.createNormalizeCtx)({
                name: 'full',
                contributes: {
                    commands: [{ command: 'sample.run', title: 'Run' }],
                    keybindings: [{ key: 'ctrl+r', command: 'sample.run' }],
                    configuration: { title: 'Sample', properties: { enabled: { type: 'boolean' } } }
                }
            });
            const contributions = await (0, normalize_contributions_1.normalizeContributions)(ctx, {});
            (0, chai_1.expect)(contributions).to.have.property('commands').with.lengthOf(1);
            (0, chai_1.expect)(contributions).to.have.property('keybindings').with.lengthOf(1);
            (0, chai_1.expect)(contributions).to.have.property('configuration').with.lengthOf(1);
        });
        it('runs the orchestrator for shell layout, passthrough, and async contribution kinds', async () => {
            const readGrammars = async () => [{
                    language: 'sample-lang',
                    scope: 'source.sample',
                    format: 'json',
                    grammar: { scopeName: 'source.sample' },
                    grammarLocation: './grammar.json'
                }];
            const ctx = (0, test_helpers_1.createNormalizeCtx)({
                name: 'orchestrator',
                displayName: 'Orchestrator Extension',
                contributes: {
                    configuration: [
                        { title: 'General', properties: { 'sample.enabled': { type: 'boolean' } } },
                        { title: 'Advanced', properties: { 'sample.count': { type: 'number' } } }
                    ],
                    configurationDefaults: { 'sample.enabled': true },
                    submenus: [{ id: 'sample.submenu', label: 'Sample', icon: '$(gear)' }],
                    customEditors: [{ viewType: 'sample.editor', displayName: 'Editor' }],
                    viewsContainers: {
                        activitybar: [{ id: 'sample.container', title: 'Sample', icon: './media/icon.png' }],
                        panel: [{ id: 'panel.container', title: 'Panel', icon: '$(panel)' }]
                    },
                    views: {
                        explorer: [{ id: 'sample.view', name: 'Sample View' }]
                    },
                    viewsWelcome: [{ view: 'sample.view', contents: 'Welcome' }],
                    commands: [{ command: 'sample.run', title: 'Run' }],
                    menus: {
                        'editor/title': [{ command: 'sample.run', group: 'navigation' }]
                    },
                    keybindings: [{ key: 'ctrl+shift+r', command: 'sample.run' }],
                    debuggers: [{ type: 'node', label: 'Node Debug', program: './debug.js' }],
                    taskDefinitions: [{
                            type: 'npm',
                            required: ['script'],
                            properties: { script: { type: 'string' } }
                        }],
                    problemMatchers: [{ name: 'sample-matcher' }],
                    problemPatterns: [{ regexp: 'sample' }],
                    resourceLabelFormatters: [{ scheme: 'file' }],
                    authentication: [{ id: 'github', label: 'GitHub' }],
                    notebooks: [{ type: 'sample-notebook', displayName: 'Notebook' }],
                    notebookRenderer: [{ id: 'sample-renderer', displayName: 'Renderer' }],
                    notebookPreload: [{ type: 'sample-preload' }],
                    snippets: [{ language: 'typescript', path: './snippets/ts.json' }],
                    themes: [{ id: 'dark', label: 'Dark', path: './themes/dark.json' }],
                    colors: [{
                            id: 'sample.color',
                            description: 'Sample',
                            defaults: { light: '#fff', dark: '#000', highContrast: '#111' }
                        }],
                    iconThemes: [{ id: 'sample-icons', label: 'Icons', path: './icons/theme.json' }],
                    icons: {
                        'sample-icon': {
                            description: 'Sample icon',
                            default: 'other-icon'
                        }
                    },
                    terminal: { profiles: [{ id: 'bash', title: 'Bash' }] },
                    localizations: [{
                            languageId: 'de',
                            languageName: 'German',
                            translations: [{ id: 'package', path: './package.nls.de.json' }]
                        }],
                    languages: [{ id: 'sample-lang', extensions: ['.sample'] }],
                    grammars: [{ language: 'sample-lang', scopeName: 'source.sample', path: './grammar.json' }]
                }
            }, { readGrammars });
            const contributions = await (0, normalize_contributions_1.normalizeContributions)(ctx, {});
            (0, chai_1.expect)(contributions.configurationDefaults).to.deep.equal({ 'sample.enabled': true });
            const configuration = contributions.configuration;
            (0, chai_1.expect)(configuration).to.have.lengthOf(2);
            (0, chai_1.expect)(configuration[0].properties['sample.enabled'].owner).to.equal('Orchestrator Extension');
            (0, chai_1.expect)(configuration[0].properties['sample.enabled'].group).to.equal('General');
            (0, chai_1.expect)(contributions.submenus).to.deep.equal([{
                    icon: '$(gear)',
                    id: 'sample.submenu',
                    label: 'Sample'
                }]);
            (0, chai_1.expect)(contributions.customEditors).to.deep.equal([{
                    viewType: 'sample.editor',
                    displayName: 'Editor',
                    selector: [],
                    priority: contribution_types_1.CustomEditorPriority.default
                }]);
            (0, chai_1.expect)(contributions.viewsContainers).to.deep.equal({
                left: [{
                        id: 'sample.container',
                        title: 'Sample',
                        iconUrl: 'hostedPlugin/acme_orchestrator/media/icon.png',
                        themeIcon: undefined,
                        when: undefined
                    }],
                bottom: [{
                        id: 'panel.container',
                        title: 'Panel',
                        iconUrl: 'hostedPlugin/acme_orchestrator/%24(panel)',
                        themeIcon: '$(panel)',
                        when: undefined
                    }]
            });
            (0, chai_1.expect)(contributions.views).to.deep.equal({
                explorer: [{ id: 'sample.view', name: 'Sample View', when: undefined, type: undefined }]
            });
            (0, chai_1.expect)(contributions.viewsWelcome).to.deep.equal([{
                    view: 'sample.view',
                    content: 'Welcome',
                    when: undefined,
                    enablement: undefined,
                    order: 0
                }]);
            (0, chai_1.expect)(contributions.menus).to.deep.equal({
                'editor/title': [{ command: 'sample.run', group: 'navigation', submenu: undefined, alt: undefined, when: undefined }]
            });
            (0, chai_1.expect)(contributions.debuggers).to.deep.equal([{
                    type: 'node',
                    label: 'Node Debug',
                    program: './debug.js',
                    languages: undefined,
                    enableBreakpointsFor: undefined,
                    variables: undefined,
                    adapterExecutableCommand: undefined,
                    configurationSnippets: undefined,
                    win: undefined,
                    winx86: undefined,
                    windows: undefined,
                    osx: undefined,
                    linux: undefined,
                    args: undefined,
                    runtime: undefined,
                    runtimeArgs: undefined,
                    configurationAttributes: undefined
                }]);
            (0, chai_1.expect)(contributions.taskDefinitions).to.deep.equal([{
                    taskType: 'npm',
                    source: 'orchestrator',
                    properties: {
                        required: ['script'],
                        all: ['script'],
                        schema: {
                            type: 'object',
                            required: ['script'],
                            properties: {
                                type: { type: 'string', const: 'npm' },
                                script: { type: 'string' }
                            }
                        }
                    }
                }]);
            (0, chai_1.expect)(contributions.problemMatchers).to.deep.equal([{ name: 'sample-matcher' }]);
            (0, chai_1.expect)(contributions.problemPatterns).to.deep.equal([{ regexp: 'sample' }]);
            (0, chai_1.expect)(contributions.resourceLabelFormatters).to.deep.equal([{ scheme: 'file' }]);
            (0, chai_1.expect)(contributions.authentication).to.deep.equal([{ id: 'github', label: 'GitHub' }]);
            (0, chai_1.expect)(contributions.notebooks).to.deep.equal([{ type: 'sample-notebook', displayName: 'Notebook' }]);
            (0, chai_1.expect)(contributions.notebookRenderer).to.deep.equal([{ id: 'sample-renderer', displayName: 'Renderer' }]);
            (0, chai_1.expect)(contributions.notebookPreload).to.deep.equal([{ type: 'sample-preload' }]);
            (0, chai_1.expect)(contributions.snippets).to.deep.equal([{
                    language: 'typescript',
                    source: 'Orchestrator Extension',
                    uri: 'hostedPlugin/acme_orchestrator/snippets/ts.json'
                }]);
            (0, chai_1.expect)(contributions.themes).to.deep.equal([{
                    id: 'dark',
                    label: 'Dark',
                    uri: 'hostedPlugin/acme_orchestrator/themes/dark.json',
                    description: undefined,
                    uiTheme: undefined
                }]);
            (0, chai_1.expect)(contributions.colors).to.deep.equal([{
                    id: 'sample.color',
                    description: 'Sample',
                    defaults: { light: '#fff', dark: '#000', hc: '#111' }
                }]);
            (0, chai_1.expect)(contributions.iconThemes).to.deep.equal([{
                    id: 'sample-icons',
                    label: 'Icons',
                    uri: 'hostedPlugin/acme_orchestrator/icons/theme.json',
                    description: undefined,
                    uiTheme: undefined
                }]);
            (0, chai_1.expect)(contributions.icons).to.deep.equal([{
                    id: 'sample-icon',
                    extensionId: 'acme.orchestrator',
                    description: 'Sample icon',
                    defaults: { id: 'other-icon' }
                }]);
            (0, chai_1.expect)(contributions.terminalProfiles).to.deep.equal([{ id: 'bash', title: 'Bash' }]);
            (0, chai_1.expect)(contributions.localizations).to.deep.equal([{
                    languageId: 'de',
                    languageName: 'German',
                    localizedLanguageName: undefined,
                    minimalTranslations: undefined,
                    translations: [{ id: 'package', path: './package.nls.de.json' }]
                }]);
            (0, chai_1.expect)(contributions.languages).to.deep.equal([{
                    id: 'sample-lang',
                    aliases: undefined,
                    extensions: ['.sample'],
                    filenamePatterns: undefined,
                    filenames: undefined,
                    firstLine: undefined,
                    mimetypes: undefined,
                    icon: undefined
                }]);
            (0, chai_1.expect)(contributions.grammars).to.deep.equal([{
                    language: 'sample-lang',
                    scope: 'source.sample',
                    format: 'json',
                    grammar: { scopeName: 'source.sample' },
                    grammarLocation: './grammar.json'
                }]);
        });
        it('merges aliased view container locations and reports async reader failures', async () => {
            const errors = [];
            const ctx = (0, test_helpers_1.createNormalizeCtx)({
                name: 'merge',
                contributes: {
                    viewsContainers: {
                        activitybar: [{ id: 'left-a', title: 'A', icon: '$(a)' }],
                        secondarySidebar: [{ id: 'right-a', title: 'Right', icon: '$(b)' }]
                    },
                    languages: [{ id: 'broken', configuration: './missing.json' }],
                    grammars: [{ language: 'broken', scopeName: 'source.broken', path: './broken.json' }]
                }
            }, {
                readJsonFile: async () => {
                    throw new Error('missing language config');
                },
                readGrammars: async () => {
                    throw new Error('missing grammar');
                },
                onError: (kind, message) => {
                    errors.push({ kind, message });
                }
            });
            const contributions = await (0, normalize_contributions_1.normalizeContributions)(ctx, {});
            (0, chai_1.expect)(contributions.viewsContainers).to.deep.equal({
                left: [{
                        id: 'left-a',
                        title: 'A',
                        iconUrl: 'hostedPlugin/acme_merge/%24(a)',
                        themeIcon: '$(a)',
                        when: undefined
                    }],
                right: [{
                        id: 'right-a',
                        title: 'Right',
                        iconUrl: 'hostedPlugin/acme_merge/%24(b)',
                        themeIcon: '$(b)',
                        when: undefined
                    }]
            });
            (0, chai_1.expect)(contributions).to.not.have.property('languages');
            (0, chai_1.expect)(contributions).to.not.have.property('grammars');
            (0, chai_1.expect)(errors.map(error => error.kind)).to.include.members(['languages', 'grammars']);
        });
        it('continues after reader errors and reports them', async () => {
            const errors = [];
            const ctx = (0, test_helpers_1.createNormalizeCtx)({
                name: 'broken',
                contributes: {
                    commands: [{ command: 'ok', title: 'OK' }],
                    configuration: { title: 'Broken' }
                }
            }, {
                readConfiguration: () => {
                    throw new Error('boom');
                },
                onError: (kind, message) => {
                    errors.push({ kind, message });
                }
            });
            const contributions = await (0, normalize_contributions_1.normalizeContributions)(ctx, {});
            (0, chai_1.expect)(contributions).to.have.property('commands').with.lengthOf(1);
            (0, chai_1.expect)(contributions).to.have.property('configuration').that.is.empty;
            (0, chai_1.expect)(errors).to.have.lengthOf(1);
            (0, chai_1.expect)(errors[0].kind).to.equal('configuration');
            (0, chai_1.expect)(errors[0].message).to.be.instanceOf(Error);
        });
    });
    describe('readWalkthroughs', () => {
        it('resolves media and plugin icon URLs for browser-only static hosting', async () => {
            const ctx = (0, test_helpers_1.createNormalizeCtx)({
                name: 'test-plugin',
                publisher: 'test-publisher',
                icon: 'images/icon.png',
                contributes: {
                    walkthroughs: [{
                            id: 'getStarted',
                            title: 'Get Started',
                            description: 'Intro',
                            steps: [{
                                    id: 'open',
                                    title: 'Open a folder',
                                    description: '',
                                    media: { markdown: 'walkthroughs/open.md' }
                                }]
                        }]
                }
            });
            const contributions = await (0, normalize_contributions_1.normalizeContributions)(ctx, {});
            (0, chai_1.expect)(contributions).to.have.property('walkthroughs').with.lengthOf(1);
            const walkthrough = contributions.walkthroughs[0];
            (0, chai_1.expect)(walkthrough.pluginId).to.equal('test-publisher.test-plugin');
            (0, chai_1.expect)(walkthrough.pluginIcon).to.equal('hostedPlugin/test_publisher_test_plugin/images/icon.png');
            (0, chai_1.expect)(walkthrough.steps[0].media).to.deep.equal({
                markdown: 'hostedPlugin/test_publisher_test_plugin/walkthroughs/open.md'
            });
        });
        it('skips walkthroughs with a missing id', () => {
            const warnings = [];
            const ctx = (0, test_helpers_1.createNormalizeCtx)({
                name: 'test-plugin',
                publisher: 'test-publisher',
                contributes: {
                    walkthroughs: [{
                            id: '',
                            title: 'Broken',
                            description: '',
                            steps: [{ id: 's1', title: 'S1', description: '' }]
                        }]
                }
            }, {
                onWarn: msg => {
                    warnings.push(msg);
                }
            });
            (0, chai_1.expect)((0, normalize_contributions_1.readWalkthroughs)(ctx.plugin, ctx)).to.be.undefined;
            (0, chai_1.expect)(warnings).to.have.lengthOf(1);
        });
    });
});
//# sourceMappingURL=normalize-contributions.spec.js.map