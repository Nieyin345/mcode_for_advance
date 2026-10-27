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
exports.VIEW_CONTAINER_LOCATION_ALIASES = exports.iconIdPattern = exports.colorIdPattern = void 0;
exports.deriveDefaultForType = deriveDefaultForType;
exports.getScope = getScope;
exports.isRawLocalization = isRawLocalization;
exports.normalizeContributions = normalizeContributions;
exports.readTerminals = readTerminals;
exports.readLocalizations = readLocalizations;
exports.readLocalization = readLocalization;
exports.readTranslation = readTranslation;
exports.readWalkthroughs = readWalkthroughs;
exports.readCommand = readCommand;
exports.transformIconUrl = transformIconUrl;
exports.readColors = readColors;
exports.readThemes = readThemes;
exports.readIconThemes = readIconThemes;
exports.readIcons = readIcons;
exports.readSnippets = readSnippets;
exports.readConfiguration = readConfiguration;
exports.readKeybinding = readKeybinding;
exports.readCustomEditors = readCustomEditors;
exports.readCustomEditor = readCustomEditor;
exports.readViewsContainers = readViewsContainers;
exports.readViewContainer = readViewContainer;
exports.readViews = readViews;
exports.readView = readView;
exports.readViewsWelcome = readViewsWelcome;
exports.readViewWelcome = readViewWelcome;
exports.extractPluginViewsIds = extractPluginViewsIds;
exports.readMenus = readMenus;
exports.readMenu = readMenu;
exports.readLanguages = readLanguages;
exports.readSubmenus = readSubmenus;
exports.readSubmenu = readSubmenu;
exports.readLanguage = readLanguage;
exports.readDebuggers = readDebuggers;
exports.readDebugger = readDebugger;
exports.readTaskDefinition = readTaskDefinition;
exports.toSchema = toSchema;
/* eslint-disable @theia/localization-check */
const fs_1 = require("fs");
const path = require("path");
const jsoncparser = require("jsonc-parser");
const utils_1 = require("../common/utils");
const protocol_shims_1 = require("../common/protocol-shims");
const contribution_types_1 = require("../common/contribution-types");
const manifest_types_1 = require("../common/manifest-types");
const constants_1 = require("../common/constants");
function isPluginUiTheme(value) {
    return value === 'vs' || value === 'vs-dark' || value === 'hc-black' || value === 'hc-light';
}
exports.colorIdPattern = '^\\w+[.\\w+]*$';
exports.iconIdPattern = `^${protocol_shims_1.ICON_NAME_SEGMENT}(-${protocol_shims_1.ICON_NAME_SEGMENT})+$`;
/** Maps the view container locations used by VS Code extensions to the Theia shell locations. */
exports.VIEW_CONTAINER_LOCATION_ALIASES = {
    activitybar: 'left',
    panel: 'bottom',
    secondarySidebar: 'right',
    auxiliarybar: 'right'
};
/**
 * Mirrors VS Code's `ConfigurationRegistry.getDefaultValue(type)`: plugins expect typed-but-defaultless properties to read as a type-based default.
 */
function deriveDefaultForType(type) {
    const t = Array.isArray(type) ? type[0] : type;
    switch (t) {
        case 'boolean': return false;
        case 'integer':
        case 'number': return 0;
        case 'string': return '';
        case 'array': return [];
        case 'object': return {};
        // eslint-disable-next-line no-null/no-null
        default: return null;
    }
}
function getScope(monacoScope) {
    switch (monacoScope) {
        case 'machine-overridable':
        case 'window':
        case 'resource':
            return { scope: protocol_shims_1.PreferenceScope.Folder, overridable: false };
        case 'language-overridable':
            return { scope: protocol_shims_1.PreferenceScope.Folder, overridable: true };
        case 'application':
        case 'machine':
            return { scope: protocol_shims_1.PreferenceScope.User, overridable: false };
    }
    return { scope: undefined, overridable: false };
}
function getFileExtension(filePath) {
    const index = filePath.lastIndexOf('.');
    return index === -1 ? '' : filePath.substring(index + 1);
}
function isCharacterPair(something) {
    return (0, utils_1.isStringArray)(something) && something.length === 2;
}
function isRawLocalization(entry) {
    return (0, utils_1.isObject)(entry) && typeof entry.languageId === 'string';
}
function toCustomEditorPriority(priority) {
    if (priority === contribution_types_1.CustomEditorPriority.option || priority === contribution_types_1.CustomEditorPriority.builtin) {
        return priority;
    }
    return contribution_types_1.CustomEditorPriority.default;
}
async function readJson(ctx, filePath) {
    if (ctx.readJsonFile) {
        return ctx.readJsonFile(filePath);
    }
    try {
        const content = await fs_1.promises.readFile(filePath, { encoding: 'utf8' });
        return content ? jsoncparser.parse(content, undefined, { disallowComments: false }) : undefined;
    }
    catch (e) {
        if (!(0, utils_1.isENOENT)(e)) {
            throw e;
        }
        return undefined;
    }
}
async function normalizeContributions(ctx, contributions) {
    const output = contributions;
    const rawPlugin = ctx.plugin;
    const contributes = (0, manifest_types_1.rawContributes)(rawPlugin);
    const readConfigurationFn = ctx.readConfiguration ?? readConfiguration;
    const readSubmenusFn = ctx.readSubmenus ?? ((submenus, plugin) => readSubmenus(ctx, submenus, plugin));
    const readCustomEditorsFn = ctx.readCustomEditors ?? readCustomEditors;
    const readViewsContainersFn = ctx.readViewsContainers ?? ((containers, plugin) => readViewsContainers(ctx, containers, plugin));
    const readViewsFn = ctx.readViews ?? readViews;
    const readViewsWelcomeFn = ctx.readViewsWelcome ?? readViewsWelcome;
    const readCommandFn = ctx.readCommand ?? ((command, plugin) => readCommand(ctx, command, plugin));
    const readMenusFn = ctx.readMenus ?? readMenus;
    const readKeybindingFn = ctx.readKeybinding ?? readKeybinding;
    const readDebuggersFn = ctx.readDebuggers ?? readDebuggers;
    const readTaskDefinitionFn = ctx.readTaskDefinition ?? ((pluginName, definition) => readTaskDefinition(pluginName, definition, ctx));
    const readSnippetsFn = ctx.readSnippets ?? (plugin => readSnippets(ctx, plugin));
    const readThemesFn = ctx.readThemes ?? (plugin => readThemes(ctx, plugin));
    const readIconsFn = ctx.readIcons ?? (plugin => readIcons(ctx, plugin));
    const readIconThemesFn = ctx.readIconThemes ?? (plugin => readIconThemes(ctx, plugin));
    const readColorsFn = ctx.readColors ?? (plugin => readColors(ctx, plugin));
    const readTerminalsFn = ctx.readTerminals ?? readTerminals;
    const readLocalizationsFn = ctx.readLocalizations ?? (plugin => readLocalizations(plugin, ctx));
    const readWalkthroughsFn = ctx.readWalkthroughs ?? (plugin => readWalkthroughs(plugin, ctx));
    const readLanguagesFn = ctx.readLanguages ?? ((languages, plugin) => readLanguages(ctx, languages, plugin));
    try {
        if (contributes.configuration) {
            const configurations = Array.isArray(contributes.configuration) ? contributes.configuration : [contributes.configuration];
            const hasMultipleConfigs = configurations.length > 1;
            output.configuration = [];
            for (const c of configurations) {
                const config = readConfigurationFn(c, rawPlugin.packagePath);
                if (config) {
                    Object.values(config.properties).forEach(property => {
                        if (hasMultipleConfigs) {
                            property.owner = rawPlugin.displayName;
                            property.group = config.title;
                        }
                        else {
                            property.owner = config.title;
                        }
                    });
                    output.configuration.push(config);
                }
            }
        }
    }
    catch (err) {
        ctx.onError('configuration', err, contributes.configuration);
    }
    output.problemMatchers = contributes.problemMatchers;
    output.problemPatterns = contributes.problemPatterns;
    output.resourceLabelFormatters = contributes.resourceLabelFormatters;
    output.authentication = contributes.authentication;
    output.notebooks = contributes.notebooks;
    output.notebookRenderer = contributes.notebookRenderer;
    output.notebookPreload = contributes.notebookPreload;
    const configurationDefaults = contributes.configurationDefaults;
    output.configurationDefaults = (0, utils_1.isObject)(configurationDefaults) ? configurationDefaults : undefined;
    try {
        if (contributes.submenus) {
            output.submenus = readSubmenusFn(contributes.submenus, rawPlugin);
        }
    }
    catch (err) {
        ctx.onError('submenus', err, contributes.submenus);
    }
    try {
        if (contributes.customEditors) {
            output.customEditors = readCustomEditorsFn(contributes.customEditors);
        }
    }
    catch (err) {
        ctx.onError('customEditors', err, contributes.customEditors);
    }
    try {
        if (contributes.viewsContainers) {
            const viewsContainers = {};
            for (const location of Object.keys(contributes.viewsContainers)) {
                const containers = readViewsContainersFn(contributes.viewsContainers[location], rawPlugin);
                const loc = exports.VIEW_CONTAINER_LOCATION_ALIASES[location] ?? location;
                const existing = viewsContainers[loc];
                viewsContainers[loc] = existing ? existing.concat(containers) : containers;
            }
            output.viewsContainers = viewsContainers;
        }
    }
    catch (err) {
        ctx.onError('viewsContainers', err, contributes.viewsContainers);
    }
    try {
        if (contributes.views) {
            const views = {};
            for (const location of Object.keys(contributes.views)) {
                views[location] = readViewsFn(contributes.views[location]);
            }
            output.views = views;
        }
    }
    catch (err) {
        ctx.onError('views', err, contributes.views);
    }
    try {
        if (contributes.viewsWelcome) {
            output.viewsWelcome = readViewsWelcomeFn(contributes.viewsWelcome, contributes.views);
        }
    }
    catch (err) {
        ctx.onError('viewsWelcome', err, contributes.viewsWelcome);
    }
    try {
        const pluginCommands = contributes.commands;
        if (pluginCommands) {
            const commands = Array.isArray(pluginCommands) ? pluginCommands : [pluginCommands];
            output.commands = commands.map(command => readCommandFn(command, rawPlugin));
        }
    }
    catch (err) {
        ctx.onError('commands', err, contributes.commands);
    }
    try {
        if (contributes.menus) {
            const menus = {};
            for (const location of Object.keys(contributes.menus)) {
                menus[location] = readMenusFn(contributes.menus[location]);
            }
            output.menus = menus;
        }
    }
    catch (err) {
        ctx.onError('menus', err, contributes.menus);
    }
    try {
        if (contributes.keybindings) {
            const rawKeybindings = Array.isArray(contributes.keybindings) ? contributes.keybindings : [contributes.keybindings];
            output.keybindings = rawKeybindings.map(rawKeybinding => readKeybindingFn(rawKeybinding));
        }
    }
    catch (err) {
        ctx.onError('keybindings', err, contributes.keybindings);
    }
    try {
        if (contributes.debuggers) {
            output.debuggers = readDebuggersFn(contributes.debuggers);
        }
    }
    catch (err) {
        ctx.onError('debuggers', err, contributes.debuggers);
    }
    try {
        if (contributes.taskDefinitions) {
            output.taskDefinitions = contributes.taskDefinitions.map(definitionContribution => readTaskDefinitionFn(rawPlugin.name, definitionContribution));
        }
    }
    catch (err) {
        ctx.onError('taskDefinitions', err, contributes.taskDefinitions);
    }
    try {
        output.snippets = readSnippetsFn(rawPlugin);
    }
    catch (err) {
        ctx.onError('snippets', err, contributes.snippets);
    }
    try {
        output.themes = readThemesFn(rawPlugin);
    }
    catch (err) {
        ctx.onError('themes', err, contributes.themes);
    }
    try {
        output.icons = readIconsFn(rawPlugin);
    }
    catch (err) {
        ctx.onError('icons', err, contributes.icons);
    }
    try {
        output.iconThemes = readIconThemesFn(rawPlugin);
    }
    catch (err) {
        ctx.onError('iconThemes', err, contributes.iconThemes);
    }
    try {
        output.colors = readColorsFn(rawPlugin);
    }
    catch (err) {
        ctx.onError('colors', err, contributes.colors);
    }
    try {
        output.terminalProfiles = readTerminalsFn(rawPlugin);
    }
    catch (err) {
        ctx.onError('terminals', err, contributes.terminal);
    }
    try {
        output.localizations = readLocalizationsFn(rawPlugin);
    }
    catch (err) {
        ctx.onError('localizations', err, contributes.localizations);
    }
    try {
        output.walkthroughs = readWalkthroughsFn(rawPlugin);
    }
    catch (err) {
        ctx.onError('walkthroughs', err, contributes.walkthroughs);
    }
    const [languagesResult, grammarsResult] = await Promise.allSettled([
        contributes.languages ? readLanguagesFn(contributes.languages, rawPlugin) : undefined,
        contributes.grammars && ctx.readGrammars
            ? ctx.readGrammars(contributes.grammars, rawPlugin.packagePath)
            : undefined
    ]);
    if (contributes.languages) {
        if (languagesResult.status === 'fulfilled') {
            output.languages = languagesResult.value;
        }
        else {
            ctx.onError('languages', languagesResult.reason, contributes.languages);
        }
    }
    if (contributes.grammars) {
        if (grammarsResult.status === 'fulfilled') {
            output.grammars = grammarsResult.value;
        }
        else {
            ctx.onError('grammars', grammarsResult.reason, contributes.grammars);
        }
    }
    // Drop keys with `undefined`
    for (const key of Object.keys(output)) {
        if (output[key] === undefined) {
            delete output[key];
        }
    }
    return output;
}
function readTerminals(pck) {
    const terminal = (0, manifest_types_1.rawContributes)(pck).terminal;
    if (!terminal?.profiles) {
        return undefined;
    }
    return terminal.profiles.filter((profile) => !!(profile.id && profile.title));
}
function readLocalizations(pck, ctx) {
    const localizations = (0, manifest_types_1.rawContributes)(pck).localizations;
    if (!Array.isArray(localizations)) {
        return undefined;
    }
    const readLocalizationFn = ctx?.readLocalization ?? ((entry, pluginPath) => readLocalization(entry, pluginPath, ctx));
    return localizations
        .filter(isRawLocalization)
        .map(entry => readLocalizationFn(entry, pck.packagePath));
}
function readLocalization({ languageId, languageName, localizedLanguageName, translations, minimalTranslations }, pluginPath, ctx) {
    const readTranslationFn = ctx?.readTranslation ?? readTranslation;
    const local = {
        languageId,
        languageName,
        localizedLanguageName,
        minimalTranslations,
        translations: []
    };
    if (Array.isArray(translations)) {
        local.translations = translations.map(entry => readTranslationFn(entry, pluginPath));
    }
    return local;
}
function readTranslation(packageTranslation, _pluginPath) {
    return {
        id: packageTranslation.id,
        path: packageTranslation.path
    };
}
function readWalkthroughs(pck, ctx) {
    const walkthroughs = (0, manifest_types_1.rawContributes)(pck).walkthroughs;
    if (!walkthroughs) {
        return undefined;
    }
    const pluginId = `${(pck.publisher ?? constants_1.UNPUBLISHED).toLowerCase()}.${pck.name.toLowerCase()}`;
    // `PluginModel` does not carry the extension icon, so it travels with the walkthroughs that show it.
    const pluginIcon = pck.icon ? ctx.resolveUrl(pck.icon) : undefined;
    const result = [];
    for (const walkthrough of walkthroughs) {
        if (typeof walkthrough.id !== 'string' || !walkthrough.id) {
            ctx.onWarn(`'contributes.walkthroughs.id' of '${pluginId}' must be defined and non-empty`);
            continue;
        }
        if (typeof walkthrough.title !== 'string' || !walkthrough.title) {
            ctx.onWarn(`'contributes.walkthroughs.title' of '${pluginId}.${walkthrough.id}' must be defined and non-empty`);
            continue;
        }
        if (!Array.isArray(walkthrough.steps)) {
            ctx.onWarn(`'contributes.walkthroughs.steps' of '${pluginId}.${walkthrough.id}' must be an array`);
            continue;
        }
        const steps = [];
        for (const step of walkthrough.steps) {
            if (typeof step.id !== 'string' || !step.id) {
                ctx.onWarn(`'contributes.walkthroughs.steps.id' of '${pluginId}.${walkthrough.id}' must be defined and non-empty`);
                continue;
            }
            if (typeof step.title !== 'string' || !step.title) {
                ctx.onWarn(`'contributes.walkthroughs.steps.title' of '${pluginId}.${walkthrough.id}.${step.id}' must be defined and non-empty`);
                continue;
            }
            steps.push({
                id: step.id,
                title: step.title,
                description: step.description || '',
                media: resolveWalkthroughMedia(ctx, step.media),
                completionEvents: step.completionEvents,
                when: step.when
            });
        }
        result.push({
            id: walkthrough.id,
            title: walkthrough.title,
            description: walkthrough.description || '',
            steps,
            when: walkthrough.when,
            icon: walkthrough.icon,
            pluginId,
            pluginIcon
        });
    }
    return result.length > 0 ? result : undefined;
}
function resolveWalkthroughMedia(ctx, media) {
    if (!media) {
        return undefined;
    }
    if ('markdown' in media) {
        return { markdown: ctx.resolveUrl(media.markdown) };
    }
    const altText = 'altText' in media ? media.altText : undefined;
    if ('svg' in media) {
        return { svg: ctx.resolveUrl(media.svg), ...(altText !== undefined && { altText }) };
    }
    if ('image' in media) {
        if (typeof media.image === 'string') {
            return { image: ctx.resolveUrl(media.image), ...(altText !== undefined && { altText }) };
        }
        // Only `dark` and `light` are mandatory; the high contrast variants fall back to them.
        const dark = ctx.resolveUrl(media.image.dark);
        const light = ctx.resolveUrl(media.image.light);
        return {
            image: {
                dark,
                light,
                hc: media.image.hc ? ctx.resolveUrl(media.image.hc) : dark,
                hcLight: media.image.hcLight ? ctx.resolveUrl(media.image.hcLight) : light
            },
            ...(altText !== undefined && { altText })
        };
    }
    return undefined;
}
function readCommand(ctx, command, pck) {
    const { themeIcon, iconUrl } = (ctx.transformIconUrl
        ? ctx.transformIconUrl(pck, command.icon)
        : transformIconUrl(ctx, pck, command.icon)) ?? {};
    return {
        command: command.command,
        title: command.title,
        shortTitle: command.shortTitle,
        originalTitle: command.original,
        category: command.category,
        iconUrl,
        themeIcon,
        enablement: command.enablement
    };
}
function transformIconUrl(ctx, _plugin, original) {
    if (original) {
        if (typeof original === 'string') {
            if (original.startsWith('$(')) {
                return { themeIcon: original };
            }
            return { iconUrl: ctx.resolveUrl(original) };
        }
        return {
            iconUrl: {
                light: ctx.resolveUrl(original.light),
                dark: ctx.resolveUrl(original.dark)
            }
        };
    }
    return undefined;
}
function readColors(ctx, pck) {
    const colors = (0, manifest_types_1.rawContributes)(pck).colors;
    if (!Array.isArray(colors)) {
        return undefined;
    }
    const result = [];
    for (const contribution of colors) {
        if (!(0, utils_1.isObject)(contribution)) {
            continue;
        }
        if (typeof contribution.id !== 'string' || contribution.id.length === 0) {
            ctx.onWarn("'configuration.colors.id' must be defined and can not be empty");
            continue;
        }
        if (!contribution.id.match(exports.colorIdPattern)) {
            ctx.onWarn("'configuration.colors.id' must follow the word[.word]*");
            continue;
        }
        if (typeof contribution.description !== 'string' || contribution.description.length === 0) {
            ctx.onWarn("'configuration.colors.description' must be defined and can not be empty");
            continue;
        }
        const defaults = contribution.defaults;
        if (!(0, utils_1.isColorDefaults)(defaults)) {
            ctx.onWarn("'configuration.colors.defaults' must be defined and must contain 'light', 'dark' and 'highContrast'");
            continue;
        }
        result.push({
            id: contribution.id,
            description: contribution.description,
            defaults: {
                light: defaults.light,
                dark: defaults.dark,
                hc: defaults.highContrast
            }
        });
    }
    return result;
}
function readThemes(ctx, pck) {
    const themes = (0, manifest_types_1.rawContributes)(pck).themes;
    if (!Array.isArray(themes)) {
        return undefined;
    }
    const result = [];
    for (const contribution of themes) {
        if (!(0, utils_1.isObject)(contribution)) {
            continue;
        }
        if (typeof contribution.path === 'string' && contribution.path) {
            result.push({
                id: typeof contribution.id === 'string' ? contribution.id : undefined,
                uri: ctx.resolveUri(pck, contribution.path),
                description: typeof contribution.description === 'string' ? contribution.description : undefined,
                label: typeof contribution.label === 'string' ? contribution.label : undefined,
                uiTheme: isPluginUiTheme(contribution.uiTheme) ? contribution.uiTheme : undefined,
            });
        }
    }
    return result;
}
function readIconThemes(ctx, pck) {
    const iconThemes = (0, manifest_types_1.rawContributes)(pck).iconThemes;
    if (!Array.isArray(iconThemes)) {
        return undefined;
    }
    const result = [];
    for (const contribution of iconThemes) {
        if (!(0, utils_1.isObject)(contribution)) {
            continue;
        }
        if (typeof contribution.id !== 'string' || !contribution.id) {
            ctx.onWarn(`Expected string in \`contributes.iconThemes.id\`. Provided value: ${String(contribution.id)}`);
            continue;
        }
        if (typeof contribution.path !== 'string' || !contribution.path) {
            ctx.onWarn(`Expected string in \`contributes.iconThemes.path\`. Provided value: ${String(contribution.path)}`);
            continue;
        }
        result.push({
            id: contribution.id,
            uri: ctx.resolveUri(pck, contribution.path),
            description: typeof contribution.description === 'string' ? contribution.description : undefined,
            label: typeof contribution.label === 'string' ? contribution.label : undefined,
            uiTheme: isPluginUiTheme(contribution.uiTheme) ? contribution.uiTheme : undefined,
        });
    }
    return result;
}
function readIcons(ctx, pck) {
    const icons = (0, manifest_types_1.rawContributes)(pck).icons;
    if (!(0, utils_1.isObject)(icons)) {
        return undefined;
    }
    const result = [];
    for (const id in icons) {
        if (!Object.prototype.hasOwnProperty.call(icons, id)) {
            continue;
        }
        if (!id.match(exports.iconIdPattern)) {
            ctx.onWarn('\'configuration.icons\' keys represent the icon id and can only contain letter, digits and minuses. ' +
                'They need to consist of at least two segments in the form `component-iconname`. ' +
                `extension: ${pck.name} icon id: ${id}`);
            return;
        }
        const iconContribution = icons[id];
        if (!(0, utils_1.isObject)(iconContribution) || typeof iconContribution.description !== 'string' || iconContribution.description.length === 0) {
            ctx.onWarn(`configuration.icons.description must be defined and can not be empty, extension: ${pck.name} icon id: ${id}`);
            return;
        }
        const defaultIcon = iconContribution.default;
        if (typeof defaultIcon === 'string') {
            result.push({
                id,
                extensionId: `${pck.publisher}.${pck.name}`,
                description: iconContribution.description,
                defaults: { id: defaultIcon }
            });
        }
        else if ((0, utils_1.isObject)(defaultIcon) && typeof defaultIcon.fontPath === 'string' && typeof defaultIcon.fontCharacter === 'string') {
            const format = getFileExtension(defaultIcon.fontPath);
            if (['woff', 'woff2', 'ttf'].indexOf(format) === -1) {
                ctx.onWarn(`Expected \`contributes.icons.default.fontPath\` to have file extension 'woff', woff2' or 'ttf', is '${format}'.`);
                return;
            }
            const iconFontLocation = ctx.resolveUri(pck, defaultIcon.fontPath);
            result.push({
                id,
                extensionId: `${pck.publisher}.${pck.name}`,
                description: iconContribution.description,
                defaults: {
                    fontCharacter: defaultIcon.fontCharacter,
                    location: iconFontLocation
                }
            });
        }
        else {
            ctx.onWarn("'configuration.icons.default' must be either a reference to the id of an other theme icon (string) " +
                'or a icon definition (object) with properties `fontPath` and `fontCharacter`.');
        }
    }
    return result;
}
function readSnippets(ctx, pck) {
    const snippets = (0, manifest_types_1.rawContributes)(pck).snippets;
    if (!Array.isArray(snippets)) {
        return undefined;
    }
    const result = [];
    for (const contribution of snippets) {
        if (!(0, utils_1.isObject)(contribution)) {
            continue;
        }
        if (typeof contribution.path === 'string' && contribution.path) {
            result.push({
                language: typeof contribution.language === 'string' ? contribution.language : undefined,
                source: pck.displayName || pck.name,
                uri: ctx.resolveUri(pck, contribution.path)
            });
        }
    }
    return result;
}
function readConfiguration(rawConfiguration, _pluginPath) {
    const { scope, overridable } = getScope(rawConfiguration.scope);
    const schema = {
        scope,
        defaultOverridable: overridable,
        title: rawConfiguration.title,
        properties: {}
    };
    if (rawConfiguration.properties) {
        for (const [key, property] of Object.entries(rawConfiguration.properties)) {
            const scopeInfo = getScope(property.scope);
            const schemaProperty = {
                ...property,
                scope: scopeInfo.scope,
                overridable: scopeInfo.overridable,
                default: property.default !== undefined ? property.default : deriveDefaultForType(property.type)
            };
            schema.properties[key] = schemaProperty;
        }
    }
    return schema;
}
function readKeybinding(rawKeybinding) {
    return {
        keybinding: rawKeybinding.key,
        command: rawKeybinding.command,
        when: rawKeybinding.when,
        mac: rawKeybinding.mac,
        linux: rawKeybinding.linux,
        win: rawKeybinding.win,
        args: rawKeybinding.args
    };
}
function readCustomEditors(rawCustomEditors) {
    return rawCustomEditors.map(rawCustomEditor => readCustomEditor(rawCustomEditor));
}
function readCustomEditor(rawCustomEditor) {
    return {
        viewType: rawCustomEditor.viewType,
        displayName: rawCustomEditor.displayName,
        selector: rawCustomEditor.selector || [],
        priority: toCustomEditorPriority(rawCustomEditor.priority)
    };
}
function readViewsContainers(ctx, rawViewsContainers, pck) {
    return rawViewsContainers
        .map(rawViewContainer => readViewContainer(ctx, rawViewContainer, pck))
        .filter((container) => container !== undefined);
}
function readViewContainer(ctx, rawViewContainer, pck) {
    const icon = rawViewContainer.icon;
    if (typeof icon !== 'string') {
        ctx.onError('viewsContainers', 'view container icon must be defined and must be a string', rawViewContainer);
        return undefined;
    }
    const themeIcon = icon.startsWith('$(') ? icon : undefined;
    const iconUrl = ctx.resolveUrl(icon);
    return {
        id: rawViewContainer.id,
        title: rawViewContainer.title,
        iconUrl,
        themeIcon,
        when: rawViewContainer.when,
    };
}
function readViews(rawViews) {
    return rawViews.map(rawView => readView(rawView));
}
function readView(rawView) {
    return {
        id: rawView.id,
        name: rawView.name,
        when: rawView.when,
        type: rawView.type
    };
}
function readViewsWelcome(rawViewsWelcome, rowViews) {
    return rawViewsWelcome.map(rawViewWelcome => readViewWelcome(rawViewWelcome, extractPluginViewsIds(rowViews)));
}
function readViewWelcome(rawViewWelcome, pluginViewsIds) {
    return {
        view: rawViewWelcome.view,
        content: rawViewWelcome.contents,
        when: rawViewWelcome.when,
        enablement: rawViewWelcome.enablement,
        order: pluginViewsIds.findIndex(v => v === rawViewWelcome.view) > -1 ? 0 : 1
    };
}
function extractPluginViewsIds(views) {
    const pluginViewsIds = [];
    if (views) {
        for (const location of Object.keys(views)) {
            const viewsIds = views[location]
                .filter(utils_1.isObject)
                .map(view => view.id)
                .filter((id) => typeof id === 'string');
            pluginViewsIds.push(...viewsIds);
        }
    }
    return pluginViewsIds;
}
function readMenus(rawMenus) {
    return rawMenus.map(rawMenu => readMenu(rawMenu));
}
function readMenu(rawMenu) {
    return {
        command: rawMenu.command,
        submenu: rawMenu.submenu,
        alt: rawMenu.alt,
        group: rawMenu.group,
        when: rawMenu.when
    };
}
async function readLanguages(ctx, rawLanguages, plugin) {
    return Promise.all(rawLanguages.map(language => readLanguage(ctx, language, plugin)));
}
function readSubmenus(ctx, rawSubmenus, plugin) {
    return rawSubmenus.map(submenu => readSubmenu(ctx, submenu, plugin));
}
function readSubmenu(ctx, rawSubmenu, plugin) {
    const icon = ctx.transformIconUrl
        ? ctx.transformIconUrl(plugin, rawSubmenu.icon)
        : transformIconUrl(ctx, plugin, rawSubmenu.icon);
    return {
        icon: icon?.iconUrl ?? icon?.themeIcon,
        id: rawSubmenu.id,
        label: rawSubmenu.label
    };
}
async function readLanguage(ctx, rawLang, plugin) {
    const icon = ctx.transformIconUrl
        ? ctx.transformIconUrl(plugin, rawLang.icon)
        : transformIconUrl(ctx, plugin, rawLang.icon);
    const result = {
        id: rawLang.id,
        aliases: rawLang.aliases,
        extensions: rawLang.extensions,
        filenamePatterns: rawLang.filenamePatterns,
        filenames: rawLang.filenames,
        firstLine: rawLang.firstLine,
        mimetypes: rawLang.mimetypes,
        icon: icon?.iconUrl ?? icon?.themeIcon
    };
    if (typeof rawLang.configuration === 'string') {
        const rawConfiguration = await readJson(ctx, path.resolve(plugin.packagePath, rawLang.configuration));
        if ((0, utils_1.isObject)(rawConfiguration)) {
            const configuration = {
                brackets: Array.isArray(rawConfiguration.brackets)
                    ? rawConfiguration.brackets.filter(isCharacterPair)
                    : undefined,
                comments: rawConfiguration.comments,
                folding: rawConfiguration.folding,
                wordPattern: typeof rawConfiguration.wordPattern === 'string' ? rawConfiguration.wordPattern : undefined,
                autoClosingPairs: extractValidAutoClosingPairs(ctx, rawLang.id, rawConfiguration),
                indentationRules: rawConfiguration.indentationRules,
                surroundingPairs: extractValidSurroundingPairs(ctx, rawLang.id, rawConfiguration),
                onEnterRules: Array.isArray(rawConfiguration.onEnterRules) ? rawConfiguration.onEnterRules : undefined,
            };
            result.configuration = configuration;
        }
    }
    return result;
}
function readDebuggers(rawDebuggers) {
    return rawDebuggers.map(rawDebug => readDebugger(rawDebug));
}
function readDebugger(rawDebugger) {
    return {
        type: rawDebugger.type,
        label: rawDebugger.label,
        languages: rawDebugger.languages,
        enableBreakpointsFor: rawDebugger.enableBreakpointsFor,
        variables: rawDebugger.variables,
        adapterExecutableCommand: rawDebugger.adapterExecutableCommand,
        configurationSnippets: rawDebugger.configurationSnippets,
        win: rawDebugger.win,
        winx86: rawDebugger.winx86,
        windows: rawDebugger.windows,
        osx: rawDebugger.osx,
        linux: rawDebugger.linux,
        program: rawDebugger.program,
        args: rawDebugger.args,
        runtime: rawDebugger.runtime,
        runtimeArgs: rawDebugger.runtimeArgs,
        configurationAttributes: rawDebugger.configurationAttributes
    };
}
function readTaskDefinition(pluginName, definitionContribution, ctx) {
    const propertyKeys = definitionContribution.properties && (0, utils_1.isObject)(definitionContribution.properties)
        ? Object.keys(definitionContribution.properties)
        : [];
    const schema = (ctx?.toSchema ?? toSchema)(definitionContribution);
    return {
        taskType: definitionContribution.type,
        source: pluginName,
        properties: {
            required: definitionContribution.required,
            all: propertyKeys,
            schema
        }
    };
}
function toSchema(definition) {
    const reconciliation = { ...definition, type: 'object' };
    const schema = (0, utils_1.deepClone)(reconciliation);
    if (schema.properties === undefined) {
        // eslint-disable-next-line no-null/no-null
        schema.properties = Object.create(null);
    }
    schema.type = 'object';
    schema.properties.type = { type: 'string', const: definition.type };
    return schema;
}
function extractValidAutoClosingPairs(ctx, langId, configuration) {
    const source = configuration.autoClosingPairs;
    if (typeof source === 'undefined') {
        return undefined;
    }
    if (!Array.isArray(source)) {
        ctx.onWarn(`[${langId}]: language configuration: expected \`autoClosingPairs\` to be an array.`);
        return undefined;
    }
    let result = undefined;
    for (let i = 0, len = source.length; i < len; i++) {
        const pair = source[i];
        if (Array.isArray(pair)) {
            if (!isCharacterPair(pair)) {
                ctx.onWarn(`[${langId}]: language configuration: expected \`autoClosingPairs[${i}]\` to be an array of two strings or an object.`);
                continue;
            }
            result = result || [];
            result.push({ open: pair[0], close: pair[1] });
        }
        else {
            if (!(0, utils_1.isObject)(pair)) {
                ctx.onWarn(`[${langId}]: language configuration: expected \`autoClosingPairs[${i}]\` to be an array of two strings or an object.`);
                continue;
            }
            if (typeof pair.open !== 'string') {
                ctx.onWarn(`[${langId}]: language configuration: expected \`autoClosingPairs[${i}].open\` to be a string.`);
                continue;
            }
            if (typeof pair.close !== 'string') {
                ctx.onWarn(`[${langId}]: language configuration: expected \`autoClosingPairs[${i}].close\` to be a string.`);
                continue;
            }
            if (typeof pair.notIn !== 'undefined') {
                if (!(0, utils_1.isStringArray)(pair.notIn)) {
                    ctx.onWarn(`[${langId}]: language configuration: expected \`autoClosingPairs[${i}].notIn\` to be a string array.`);
                    continue;
                }
            }
            result = result || [];
            result.push({ open: pair.open, close: pair.close, notIn: pair.notIn });
        }
    }
    return result;
}
function extractValidSurroundingPairs(ctx, langId, configuration) {
    const source = configuration.surroundingPairs;
    if (typeof source === 'undefined') {
        return undefined;
    }
    if (!Array.isArray(source)) {
        ctx.onWarn(`[${langId}]: language configuration: expected \`surroundingPairs\` to be an array.`);
        return undefined;
    }
    let result = undefined;
    for (let i = 0, len = source.length; i < len; i++) {
        const pair = source[i];
        if (Array.isArray(pair)) {
            if (!isCharacterPair(pair)) {
                ctx.onWarn(`[${langId}]: language configuration: expected \`surroundingPairs[${i}]\` to be an array of two strings or an object.`);
                continue;
            }
            result = result || [];
            result.push({ open: pair[0], close: pair[1] });
        }
        else {
            if (!(0, utils_1.isObject)(pair)) {
                ctx.onWarn(`[${langId}]: language configuration: expected \`surroundingPairs[${i}]\` to be an array of two strings or an object.`);
                continue;
            }
            if (typeof pair.open !== 'string') {
                ctx.onWarn(`[${langId}]: language configuration: expected \`surroundingPairs[${i}].open\` to be a string.`);
                continue;
            }
            if (typeof pair.close !== 'string') {
                ctx.onWarn(`[${langId}]: language configuration: expected \`surroundingPairs[${i}].close\` to be a string.`);
                continue;
            }
            result = result || [];
            result.push({ open: pair.open, close: pair.close });
        }
    }
    return result;
}
//# sourceMappingURL=normalize-contributions.js.map