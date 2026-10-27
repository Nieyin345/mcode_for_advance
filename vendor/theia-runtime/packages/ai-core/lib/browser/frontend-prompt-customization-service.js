"use strict";
// *****************************************************************************
// Copyright (C) 2024 EclipseSource GmbH.
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
exports.DefaultPromptFragmentCustomizationService = exports.CustomizationSource = exports.CUSTOM_AGENT_WORKSPACE_DIRECTORIES = exports.CUSTOM_AGENT_DEFAULT_PROMPT_STEM = exports.CUSTOM_AGENT_FILE_NAME = exports.CUSTOM_AGENTS_DIRECTORY = void 0;
exports.getCustomizationSourceString = getCustomizationSourceString;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const browser_1 = require("@theia/core/lib/browser");
const inversify_1 = require("@theia/core/shared/inversify");
const common_1 = require("../common");
const configurable_in_memory_resources_1 = require("../common/configurable-in-memory-resources");
const frontmatter_1 = require("../common/frontmatter");
const buffer_1 = require("@theia/core/lib/common/buffer");
const file_service_1 = require("@theia/filesystem/lib/browser/file-service");
const ai_core_preferences_1 = require("../common/ai-core-preferences");
const env_variables_1 = require("@theia/core/lib/common/env-variables");
const js_yaml_1 = require("js-yaml");
const prompttemplate_contribution_1 = require("./prompttemplate-contribution");
const prompttemplate_parser_1 = require("./prompttemplate-parser");
const browser_2 = require("@theia/workspace/lib/browser");
/**
 * Subdirectory (relative to a prompt-templates scope) holding one folder per custom agent.
 */
exports.CUSTOM_AGENTS_DIRECTORY = 'agents';
/**
 * Filename of the per-agent definition file (frontmatter + prompt body) inside `agents/<id>/`.
 */
exports.CUSTOM_AGENT_FILE_NAME = 'agent.md';
/**
 * Filename stem (without extension) reserved for the customization of a custom agent's
 * default prompt. Lives at `<scope>/agents/<id>/prompt.prompttemplate` and maps to
 * fragment id `<agent-name>_prompt`. Excluded from the variant loader so it doesn't double
 * as an extra variant.
 */
exports.CUSTOM_AGENT_DEFAULT_PROMPT_STEM = 'prompt';
/**
 * Workspace-relative parent folders scanned for custom agents, independent of the configurable
 * prompt-templates directories. Scanning both folders mirrors the skills convention introduced
 * in #17553, but the duplicate-id precedence is intentionally inverted: here `.agents` is listed
 * first, so it becomes the default location for newly created agents and wins over `.prompts`,
 * whereas for skills `.prompts` wins over `.agents` (see `combineSkillDirectories` in
 * `skill-service.ts`). `.prompts` is retained for backward compatibility with agents authored
 * before the move to `.agents`.
 */
exports.CUSTOM_AGENT_WORKSPACE_DIRECTORIES = ['.agents', '.prompts'];
var CustomAgentFrontmatter;
(function (CustomAgentFrontmatter) {
    function is(value) {
        if (!value || typeof value !== 'object') {
            return false;
        }
        const entry = value;
        if (typeof entry.name !== 'string' || typeof entry.description !== 'string' || typeof entry.defaultLLM !== 'string') {
            return false;
        }
        if ('showInChat' in entry && typeof entry.showInChat !== 'boolean') {
            return false;
        }
        if ('id' in entry && typeof entry.id !== 'string') {
            return false;
        }
        return true;
    }
    CustomAgentFrontmatter.is = is;
})(CustomAgentFrontmatter || (CustomAgentFrontmatter = {}));
/**
 * Default template entry for creating custom agents
 */
const newCustomAgentEntry = {
    id: 'my_agent',
    name: 'My Agent',
    description: core_1.nls.localize('theia/ai/core/customAgentTemplate/description', 'This is an example agent. Please adapt the properties to fit your needs.'),
    prompt: `{{!-- Note: The context section below will resolve all context elements (e.g. files) to their full content
in the system prompt. Context elements can be added by the user in the default chat view (e.g. via DnD or the "+" button).
If you want a more fine-grained, on demand resolvement of context elements, you can also resolve files to their paths only
and equip the agent with functions so that the LLM can retrieve files on demand. See the Coder Agent prompt for an example.--}}

# Role
You are an example agent. Be nice and helpful to the user.

## Current Context
Some files and other pieces of data may have been added by the user to the context of the chat. If any have, the details can be found below.
{{contextDetails}}`,
    defaultLLM: 'default/universal',
    showInChat: true
};
var CustomizationSource;
(function (CustomizationSource) {
    CustomizationSource[CustomizationSource["CUSTOMIZED"] = 1] = "CUSTOMIZED";
    CustomizationSource[CustomizationSource["FOLDER"] = 2] = "FOLDER";
    CustomizationSource[CustomizationSource["FILE"] = 3] = "FILE";
})(CustomizationSource || (exports.CustomizationSource = CustomizationSource = {}));
function getCustomizationSourceString(origin) {
    switch (origin) {
        case CustomizationSource.FILE:
            return 'Workspace Template Files';
        case CustomizationSource.FOLDER:
            return 'Workspace Template Directories';
        default:
            return 'Prompt Templates Folder';
    }
}
let DefaultPromptFragmentCustomizationService = class DefaultPromptFragmentCustomizationService {
    constructor() {
        /** Stores URI strings of template files from directories currently being monitored for changes. */
        this.trackedTemplateURIs = new Set();
        /** Contains the currently active customization, mapped by prompt fragment ID. */
        this.activeCustomizations = new Map();
        /** Tracks all loaded customizations, including overridden ones, mapped by source URI. */
        this.allCustomizations = new Map();
        /** Stores additional directory paths for loading template files. */
        this.additionalTemplateDirs = new Set();
        /**
         * Built-in parent directories scanned for custom agents (`.agents`, `.prompts`), independent of
         * {@link additionalTemplateDirs}. Insertion order is preserved so the first entry (`.agents`)
         * acts as the default location for newly created agents.
         */
        this.customAgentDirs = new Set();
        /** Contains file extensions that identify prompt template files. */
        this.templateExtensions = new Set([prompttemplate_contribution_1.PROMPT_TEMPLATE_EXTENSION]);
        /** Stores specific file paths, provided by the settings, that should be treated as templates. */
        this.workspaceTemplateFiles = new Set();
        /** Maps URI strings to WatchedFileInfo objects for individually watched template files. */
        this.watchedFiles = new Map();
        /**
         * For each known custom-agent prompt fragment id (i.e. `<name>_prompt`), the URI of the
         * agent's folder (`<scope>/agents/<id>/`). Populated as agents are loaded and used to
         * route customization writes/reads into the agent folder.
         */
        this.customAgentFolderByFragmentId = new Map();
        /** Collection of disposable resources for cleanup when the service updates or is disposed. */
        this.toDispose = new core_1.DisposableCollection();
        this.onDidChangePromptFragmentCustomizationEmitter = new core_1.Emitter();
        this.onDidChangePromptFragmentCustomization = this.onDidChangePromptFragmentCustomizationEmitter.event;
        this.onDidChangeCustomAgentsEmitter = new core_1.Emitter();
        this.onDidChangeCustomAgents = this.onDidChangeCustomAgentsEmitter.event;
        this.warnedLegacyYamlUris = new Set();
    }
    init() {
        this.preferences.onPreferenceChanged(event => {
            if (event.preferenceName === ai_core_preferences_1.PREFERENCE_NAME_PROMPT_TEMPLATES) {
                this.update();
            }
        });
        this.update();
    }
    /**
     * Updates the service by reloading all template files and watching for changes
     */
    async update() {
        this.toDispose.dispose();
        // we need to assign local variables, so that updates running in parallel don't interfere with each other
        const activeCustomizationsCopy = new Map();
        const trackedTemplateURIsCopy = new Set();
        const allCustomizationsCopy = new Map();
        const watchedFilesCopy = new Map();
        // Process in order of priority (lowest to highest)
        // First process the main templates directory (lowest priority)
        const templatesURI = await this.getTemplatesDirectoryURI();
        await this.processTemplateDirectory(activeCustomizationsCopy, trackedTemplateURIsCopy, allCustomizationsCopy, templatesURI, 1, CustomizationSource.CUSTOMIZED); // Priority 1 for customized fragments
        // Process additional template directories (medium priority). Skip any directory that
        // resolves to the main templates directory — a user can set both prefs to the same
        // path; re-processing the same dir overwrites the priority-1 entries with priority-2,
        // which then hides them from `editBuiltIn`'s priority-1-only lookup.
        const processedScopeKeys = new Set([templatesURI.toString()]);
        for (const dirURI of this.getDedupedAdditionalScopes(templatesURI)) {
            processedScopeKeys.add(dirURI.toString());
            await this.processTemplateDirectory(activeCustomizationsCopy, trackedTemplateURIsCopy, allCustomizationsCopy, dirURI, 2, CustomizationSource.FOLDER); // Priority 2 for folder fragments
        }
        // Process built-in custom-agent directories (`.agents`/`.prompts`) not already covered as
        // template directories above: register the prompt fragments inside their `agents/<id>/`
        // folders and watch them, so agents under these scopes get the same live refresh and
        // prompt-fragment editing as those under template directories — without loading loose
        // prompt templates from these built-in scopes themselves.
        for (const dirPath of this.customAgentDirs) {
            const scopeURI = core_1.URI.fromFilePath(dirPath);
            if (processedScopeKeys.has(scopeURI.toString())) {
                continue;
            }
            processedScopeKeys.add(scopeURI.toString());
            await this.processCustomAgentScope(activeCustomizationsCopy, trackedTemplateURIsCopy, allCustomizationsCopy, scopeURI, 2, CustomizationSource.FOLDER);
        }
        // Process specific template files (highest priority)
        await this.processTemplateFiles(activeCustomizationsCopy, trackedTemplateURIsCopy, allCustomizationsCopy, watchedFilesCopy);
        this.activeCustomizations = activeCustomizationsCopy;
        this.trackedTemplateURIs = trackedTemplateURIsCopy;
        this.allCustomizations = allCustomizationsCopy;
        this.watchedFiles = watchedFilesCopy;
        this.onDidChangeCustomAgentsEmitter.fire();
    }
    /**
     * Adds a template to the customizations map, handling conflicts based on priority
     * @param activeCustomizationsCopy The map to add the customization to
     * @param id The fragment ID
     * @param template The template content
     * @param sourceUri The URI of the source file (used to distinguish updates from conflicts)
     * @param allCustomizationsCopy The map to track all loaded customizations
     * @param priority The customization priority
     * @param origin The source type of the customization
     * @param metadata Optional command metadata
     */
    addTemplate(activeCustomizationsCopy, id, template, sourceUri, allCustomizationsCopy, priority, origin, metadata) {
        // Generate a unique customization ID based on source URI and priority
        const customizationId = this.generateCustomizationId(id, sourceUri);
        // Create customization object with metadata
        const customization = {
            id,
            template,
            sourceUri,
            sourceUris: [sourceUri],
            priority,
            customizationId,
            origin,
            ...(metadata && {
                name: metadata.name,
                description: metadata.description,
                isCommand: metadata.isCommand,
                commandName: metadata.commandName,
                commandDescription: metadata.commandDescription,
                commandArgumentHint: metadata.commandArgumentHint,
                commandAgents: metadata.commandAgents,
            })
        };
        // Always add to allCustomizationsCopy to keep track of all customizations including overridden ones
        if (sourceUri) {
            allCustomizationsCopy.set(sourceUri, customization);
        }
        const existingEntry = activeCustomizationsCopy.get(id);
        if (existingEntry) {
            // If the existing entry was merged from multiple sources and we're
            // operating on the live maps (incremental watcher update), a single
            // file change can't reconstruct the merge correctly. Schedule a
            // full rebuild instead. During update() the maps are fresh locals,
            // so this check won't fire.
            if (existingEntry.sourceUris.length > 1 && activeCustomizationsCopy === this.activeCustomizations) {
                this.update();
                return;
            }
            // If this is an update to the same file (same source URI)
            if (sourceUri && existingEntry.sourceUri === sourceUri) {
                // Update the content while keeping the same priority and source
                activeCustomizationsCopy.set(id, customization);
                return;
            }
            // If the new customization has higher priority, replace the existing one
            if (priority > existingEntry.priority) {
                activeCustomizationsCopy.set(id, customization);
                return;
            }
            else if (priority === existingEntry.priority) {
                // Same priority from different sources: concatenate with provenance labels.
                // Build a new object so we don't mutate the entry shared with allCustomizationsCopy.
                const existingLabel = this.provenanceLabel(existingEntry.sourceUri);
                const newLabel = this.provenanceLabel(sourceUri);
                const mergedTemplate = `### ${existingLabel}\n\n${existingEntry.template}\n\n### ${newLabel}\n\n${template}`;
                const mergedEntry = {
                    ...existingEntry,
                    template: mergedTemplate,
                    sourceUris: [...existingEntry.sourceUris, sourceUri],
                };
                activeCustomizationsCopy.set(id, mergedEntry);
            }
            return;
        }
        // No conflict at all, add the customization
        activeCustomizationsCopy.set(id, customization);
    }
    /**
     * Generates a unique customization ID based on the fragment ID, source URI, and priority
     * @param id The fragment ID
     * @param sourceUri The source URI of the template
     * @returns A unique customization ID
     */
    generateCustomizationId(id, sourceUri) {
        // Create a customization ID that contains information about the source and priority
        // This ensures uniqueness across different customization sources
        const sourceHash = this.hashString(sourceUri);
        return `${id}_${sourceHash}`;
    }
    /**
     * Extracts a human-readable provenance label from a source URI.
     * Returns the name of the workspace root that contains the file,
     * falling back to the file's own base name if it is not inside any root.
     */
    provenanceLabel(uri) {
        try {
            const parsed = new core_1.URI(uri);
            const rootUri = this.workspaceService.getWorkspaceRootUri(parsed);
            if (rootUri) {
                return rootUri.path.base;
            }
            return parsed.path.dir.base || parsed.path.base || uri;
        }
        catch {
            return uri;
        }
    }
    /**
     * Simple hash function to generate a short identifier from a string
     * @param str The string to hash
     * @returns A string hash
     */
    hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return Math.abs(hash).toString(36).substring(0, 8);
    }
    /**
     * Parses a template file that may contain YAML front matter
     * @param fileContent The raw file content
     * @returns Parsed metadata and template content
     */
    parseTemplateWithMetadata(fileContent) {
        return (0, prompttemplate_parser_1.parseTemplateWithMetadata)(fileContent);
    }
    /**
     * Removes a customization from customizations maps based on the source URI.
     * Also checks for any lower-priority customizations with the same ID that might need to be loaded.
     * @param sourceUri The URI of the source file being removed
     * @param allCustomizationsCopy The map of all loaded customizations
     * @param activeCustomizationsCopy The map of active customizations
     * @param trackedTemplateURIsCopy Optional set of tracked URIs to update
     * @returns The fragment ID that was removed, or undefined if no customization was found
     */
    removeCustomizationFromMaps(sourceUri, allCustomizationsCopy, activeCustomizationsCopy, trackedTemplateURIsCopy) {
        // Get the customization entry from allCustomizationsCopy
        const removedCustomization = allCustomizationsCopy.get(sourceUri);
        if (!removedCustomization) {
            return undefined;
        }
        const fragmentId = removedCustomization.id;
        allCustomizationsCopy.delete(sourceUri);
        trackedTemplateURIsCopy.delete(sourceUri);
        // If the customization is in the active customizations map, we check if there is another customization previously conflicting with it
        const activeCustomization = activeCustomizationsCopy.get(fragmentId);
        if (activeCustomization && activeCustomization.sourceUri === sourceUri) {
            activeCustomizationsCopy.delete(fragmentId);
            // Find any lower-priority customizations with the same ID that were previously ignored
            const lowerPriorityCustomizations = Array.from(allCustomizationsCopy.values())
                .filter(t => t.id === fragmentId)
                .sort((a, b) => b.priority - a.priority); // Sort by priority (highest first)
            // If there are any lower-priority customizations, add the highest priority one
            if (lowerPriorityCustomizations.length > 0) {
                const highestRemainingCustomization = lowerPriorityCustomizations[0];
                activeCustomizationsCopy.set(fragmentId, highestRemainingCustomization);
            }
        }
        return fragmentId;
    }
    /**
     * Process the template files specified by path, watching for changes
     * and loading their content into the customizations map
     * @param activeCustomizationsCopy Map to store active customizations
     * @param trackedTemplateURIsCopy Set to track URIs being monitored
     * @param allCustomizationsCopy Map to store all loaded customizations
     * @param watchedFilesCopy Map to store file watch information
     */
    async processTemplateFiles(activeCustomizationsCopy, trackedTemplateURIsCopy, allCustomizationsCopy, watchedFilesCopy) {
        const priority = 3; // Highest priority for specific files
        const parsedPromptFragments = new Set();
        for (const filePath of this.workspaceTemplateFiles) {
            const fileURI = core_1.URI.fromFilePath(filePath);
            const fragmentId = this.getFragmentIdFromFilePath(filePath);
            const uriString = fileURI.toString();
            const customizationId = this.generateCustomizationId(fragmentId, uriString);
            watchedFilesCopy.set(uriString, { uri: fileURI, fragmentId, customizationId });
            this.toDispose.push(this.fileService.watch(fileURI, { recursive: false, excludes: [] }));
            if (await this.fileService.exists(fileURI)) {
                trackedTemplateURIsCopy.add(uriString);
                const fileContent = await this.fileService.read(fileURI);
                const parsed = this.parseTemplateWithMetadata(fileContent.value);
                this.addTemplate(activeCustomizationsCopy, fragmentId, parsed.template, uriString, allCustomizationsCopy, priority, CustomizationSource.FILE, parsed.metadata);
                parsedPromptFragments.add(fragmentId);
            }
        }
        this.onDidChangePromptFragmentCustomizationEmitter.fire(Array.from(parsedPromptFragments));
        this.toDispose.push(this.fileService.onDidFilesChange(async (event) => {
            // Only watch for changes that are in the watchedFiles map
            if (!event.changes.some(change => this.watchedFiles.get(change.resource.toString()))) {
                return;
            }
            // Track changes for batched notification
            const changedFragmentIds = new Set();
            // Handle deleted files
            for (const deletedFile of event.getDeleted()) {
                const fileUriString = deletedFile.resource.toString();
                const fileInfo = this.watchedFiles.get(fileUriString);
                if (fileInfo) {
                    const removedFragmentId = this.removeCustomizationFromMaps(fileUriString, allCustomizationsCopy, activeCustomizationsCopy, trackedTemplateURIsCopy);
                    if (removedFragmentId) {
                        changedFragmentIds.add(removedFragmentId);
                    }
                }
            }
            // Handle updated files
            for (const updatedFile of event.getUpdated()) {
                const fileUriString = updatedFile.resource.toString();
                const fileInfo = this.watchedFiles.get(fileUriString);
                if (fileInfo) {
                    const fileContent = await this.fileService.read(fileInfo.uri);
                    const parsed = this.parseTemplateWithMetadata(fileContent.value);
                    this.addTemplate(this.activeCustomizations, fileInfo.fragmentId, parsed.template, fileUriString, this.allCustomizations, priority, CustomizationSource.FILE, parsed.metadata);
                    changedFragmentIds.add(fileInfo.fragmentId);
                }
            }
            // Handle newly created files
            for (const addedFile of event.getAdded()) {
                const fileUriString = addedFile.resource.toString();
                const fileInfo = this.watchedFiles.get(fileUriString);
                if (fileInfo) {
                    const fileContent = await this.fileService.read(fileInfo.uri);
                    const parsed = this.parseTemplateWithMetadata(fileContent.value);
                    this.addTemplate(this.activeCustomizations, fileInfo.fragmentId, parsed.template, fileUriString, this.allCustomizations, priority, CustomizationSource.FILE, parsed.metadata);
                    this.trackedTemplateURIs.add(fileUriString);
                    changedFragmentIds.add(fileInfo.fragmentId);
                }
            }
            const changedFragmentIdsArray = Array.from(changedFragmentIds);
            if (changedFragmentIdsArray.length > 0) {
                this.onDidChangePromptFragmentCustomizationEmitter.fire(changedFragmentIdsArray);
            }
            ;
        }));
    }
    /**
     * Extract a fragment ID from a file path
     * @param filePath The path to the template file
     * @returns A fragment ID derived from the file name
     */
    getFragmentIdFromFilePath(filePath) {
        const uri = core_1.URI.fromFilePath(filePath);
        return this.removePromptTemplateSuffix(uri.path.name);
    }
    /**
     * Processes a directory for template files, adding them to the customizations map
     * and setting up file watching
     * @param activeCustomizationsCopy Map to store active customizations
     * @param trackedTemplateURIsCopy Set to track URIs being monitored
     * @param allCustomizationsCopy Map to store all loaded customizations
     * @param dirURI URI of the directory to process
     * @param priority Priority level for customizations in this directory
     * @param customizationSource Source type of the customization
     */
    async processTemplateDirectory(activeCustomizationsCopy, trackedTemplateURIsCopy, allCustomizationsCopy, dirURI, priority, customizationSource) {
        const dirExists = await this.fileService.exists(dirURI);
        // Process existing files if directory exists
        if (dirExists) {
            await this.processExistingTemplateDirectory(activeCustomizationsCopy, trackedTemplateURIsCopy, allCustomizationsCopy, dirURI, priority, customizationSource);
            await this.processCustomAgentFolders(activeCustomizationsCopy, trackedTemplateURIsCopy, allCustomizationsCopy, dirURI, priority, customizationSource);
        }
        // Set up file watching for the directory (works for both existing and non-existing directories)
        this.setupDirectoryWatcher(dirURI, priority, customizationSource);
    }
    /**
     * Processes a built-in custom-agent scope (`.agents`/`.prompts`): registers the prompt fragments
     * inside its `agents/<id>/` folders and watches the scope for changes. Unlike
     * {@link processTemplateDirectory} it does not scan loose `*.prompttemplate` files in the scope
     * root, so `.agents` does not become a general prompt-template directory.
     * @param dirURI URI of the agent scope directory
     * @param priority Priority level for customizations in this scope
     * @param customizationSource Source type of the customization
     */
    async processCustomAgentScope(activeCustomizationsCopy, trackedTemplateURIsCopy, allCustomizationsCopy, dirURI, priority, customizationSource) {
        await this.processCustomAgentFolders(activeCustomizationsCopy, trackedTemplateURIsCopy, allCustomizationsCopy, dirURI, priority, customizationSource);
        // Watch for changes (works for both existing and non-existing directories), restricted to
        // agent folders so newly created/edited agents under `.agents` are picked up live.
        this.setupDirectoryWatcher(dirURI, priority, customizationSource, true);
    }
    /**
     * Scan `<dirURI>/agents/<id>/*.prompttemplate` files and register each as a customized
     * prompt fragment so they appear in the Prompt Fragments configuration view and so
     * `editPromptFragmentCustomization` / `removePromptFragmentCustomization` can find their
     * source URIs.
     *
     * The reserved filename `prompt.prompttemplate` maps to the agent's default-variant
     * fragment id (`<agent-name>_prompt` read from the sibling `agent.md`'s frontmatter).
     * Any other `.prompttemplate` file uses its filename stem as the fragment id (matching
     * how variants are registered via {@link readCustomAgentPromptVariants}).
     */
    async processCustomAgentFolders(activeCustomizationsCopy, trackedTemplateURIsCopy, allCustomizationsCopy, scopeDir, priority, customizationSource) {
        const agentsDirURI = scopeDir.resolve(exports.CUSTOM_AGENTS_DIRECTORY);
        let agentsStat;
        try {
            agentsStat = await this.fileService.resolve(agentsDirURI);
        }
        catch {
            return;
        }
        if (!agentsStat.isDirectory || !agentsStat.children?.length) {
            return;
        }
        for (const agentChild of agentsStat.children) {
            if (!agentChild.isDirectory) {
                continue;
            }
            const defaultFragmentId = await this.readCustomAgentDefaultFragmentId(agentChild.resource);
            if (defaultFragmentId) {
                this.customAgentFolderByFragmentId.set(defaultFragmentId, agentChild.resource);
            }
            const folderStat = await this.fileService.resolve(agentChild.resource).catch(() => undefined);
            if (!folderStat?.children?.length) {
                continue;
            }
            for (const file of folderStat.children) {
                if (!file.isFile || !this.isPromptTemplateExtension(file.resource.path.ext)) {
                    continue;
                }
                const stem = this.removePromptTemplateSuffix(file.resource.path.name);
                const fragmentId = stem === exports.CUSTOM_AGENT_DEFAULT_PROMPT_STEM ? defaultFragmentId : stem;
                if (!fragmentId) {
                    continue;
                }
                trackedTemplateURIsCopy.add(file.resource.toString());
                try {
                    const fileContent = await this.fileService.read(file.resource);
                    const parsed = this.parseTemplateWithMetadata(fileContent.value);
                    this.addTemplate(activeCustomizationsCopy, fragmentId, parsed.template, file.resource.toString(), allCustomizationsCopy, priority, customizationSource, parsed.metadata);
                }
                catch (e) {
                    this.logger.debug(`Failed to load custom-agent customization ${file.resource.toString()}: ${e?.message ?? e}`);
                }
            }
        }
    }
    /**
     * Return the parent URI when `resource` lives in `<scopeDirURI>/agents/<id>/`; otherwise
     * undefined. Used to decide whether a newly-added file should be processed as a
     * custom-agent prompt customization.
     */
    matchesCustomAgentFolder(resource, scopeDirURI) {
        const parent = resource.parent;
        const grandParent = parent.parent;
        if (!grandParent) {
            return undefined;
        }
        if (grandParent.path.base !== exports.CUSTOM_AGENTS_DIRECTORY) {
            return undefined;
        }
        if (!grandParent.parent.isEqual(scopeDirURI)) {
            return undefined;
        }
        return parent;
    }
    /**
     * Read `<agentFolderURI>/agent.md`'s frontmatter and return the implied default
     * fragment id (`<name>_prompt`). Returns undefined if the file is missing or invalid.
     */
    async readCustomAgentDefaultFragmentId(agentFolderURI) {
        try {
            const content = (await this.fileService.read(agentFolderURI.resolve(exports.CUSTOM_AGENT_FILE_NAME), { encoding: 'utf-8' })).value;
            const { metadata } = (0, frontmatter_1.parseFrontmatter)(content, { isValid: CustomAgentFrontmatter.is });
            return metadata ? `${metadata.name}_prompt` : undefined;
        }
        catch {
            return undefined;
        }
    }
    /**
     * Processes an existing directory for template files
     * @param activeCustomizationsCopy Map to store active customizations
     * @param trackedTemplateURIsCopy Set to track URIs being monitored
     * @param allCustomizationsCopy Map to store all loaded customizations
     * @param dirURI URI of the directory to process
     * @param priority Priority level for customizations in this directory
     * @param customizationSource Source type of the customization
     */
    async processExistingTemplateDirectory(activeCustomizationsCopy, trackedTemplateURIsCopy, allCustomizationsCopy, dirURI, priority, customizationSource) {
        const stat = await this.fileService.resolve(dirURI);
        if (stat.children === undefined) {
            return;
        }
        const parsedPromptFragments = new Set();
        for (const file of stat.children) {
            if (!file.isFile) {
                continue;
            }
            const fileURI = file.resource;
            if (this.isPromptTemplateExtension(fileURI.path.ext)) {
                trackedTemplateURIsCopy.add(fileURI.toString());
                const fileContent = await this.fileService.read(fileURI);
                const parsed = this.parseTemplateWithMetadata(fileContent.value);
                const fragmentId = this.removePromptTemplateSuffix(file.name);
                this.addTemplate(activeCustomizationsCopy, fragmentId, parsed.template, fileURI.toString(), allCustomizationsCopy, priority, customizationSource, parsed.metadata);
                parsedPromptFragments.add(fragmentId);
            }
        }
        this.onDidChangePromptFragmentCustomizationEmitter.fire(Array.from(parsedPromptFragments));
        this.onDidChangeCustomAgentsEmitter.fire();
    }
    /**
     * Whether a changed resource path affects custom agents, i.e. it is (or is inside) an `agents/`
     * directory, or a legacy `customAgents.yml`. Matches the `agents` directory itself (e.g. when the
     * whole folder is deleted), not only files within it, so removing `agents/` triggers a reload.
     * @param path The string form of the changed resource URI
     */
    isCustomAgentChange(path) {
        return path.endsWith('customAgents.yml')
            || path.includes(`/${exports.CUSTOM_AGENTS_DIRECTORY}/`)
            || path.endsWith(`/${exports.CUSTOM_AGENTS_DIRECTORY}`);
    }
    /**
     * Sets up file watching for a template directory (works for both existing and non-existing directories)
     * @param dirURI URI of the directory to watch
     * @param priority Priority level for customizations in this directory
     * @param customizationSource Source type of the customization
     * @param agentsOnly When true, only `agents/<id>/` prompt files are registered on add; loose
     * `*.prompttemplate` files in the scope root are ignored. Used for built-in agent scopes
     * (`.agents`) that must not become general prompt-template directories.
     */
    setupDirectoryWatcher(dirURI, priority, customizationSource, agentsOnly = false) {
        this.toDispose.push(this.fileService.watch(dirURI, { recursive: true, excludes: [] }));
        this.toDispose.push(this.fileService.onDidFilesChange(async (event) => {
            // Filter for changes within the watched directory
            if (!event.changes.some(change => change.resource.toString().startsWith(dirURI.toString()))) {
                return;
            }
            // Handle directory creation or deletion (when watching a previously non-existent directory)
            if (event.getAdded().some(addedFile => addedFile.resource.toString() === dirURI.toString()) ||
                event.getDeleted().some(deletedFile => deletedFile.resource.toString() === dirURI.toString())) {
                // Directory was created or deleted, restart the update process to handle the change
                await this.update();
                return;
            }
            if (event.changes.some(change => this.isCustomAgentChange(change.resource.toString()))) {
                this.onDidChangeCustomAgentsEmitter.fire();
            }
            // Track changes for batched notification
            const changedFragmentIds = new Set();
            // Handle deleted templates
            for (const deletedFile of event.getDeleted()) {
                const uriString = deletedFile.resource.toString();
                if (this.trackedTemplateURIs.has(uriString)) {
                    const removedFragmentId = this.removeCustomizationFromMaps(uriString, this.allCustomizations, this.activeCustomizations, this.trackedTemplateURIs);
                    if (removedFragmentId) {
                        changedFragmentIds.add(removedFragmentId);
                    }
                }
            }
            // Handle updated templates
            for (const updatedFile of event.getUpdated()) {
                const uriString = updatedFile.resource.toString();
                if (this.trackedTemplateURIs.has(uriString)) {
                    const fileContent = await this.fileService.read(updatedFile.resource);
                    const parsed = this.parseTemplateWithMetadata(fileContent.value);
                    // Prefer the already-tracked fragment id over the filename stem so that
                    // `<scope>/agents/<id>/prompt.prompttemplate` keeps mapping to `<name>_prompt`
                    // instead of becoming a fragment called `prompt`.
                    const fragmentId = this.allCustomizations.get(uriString)?.id
                        ?? this.removePromptTemplateSuffix(updatedFile.resource.path.name);
                    this.addTemplate(this.activeCustomizations, fragmentId, parsed.template, uriString, this.allCustomizations, priority, customizationSource, parsed.metadata);
                    changedFragmentIds.add(fragmentId);
                }
            }
            // Handle new templates
            for (const addedFile of event.getAdded()) {
                if (!this.isPromptTemplateExtension(addedFile.resource.path.ext)) {
                    continue;
                }
                const isScopeRoot = !agentsOnly && addedFile.resource.parent.toString() === dirURI.toString();
                const agentFolderURI = this.matchesCustomAgentFolder(addedFile.resource, dirURI);
                if (!isScopeRoot && !agentFolderURI) {
                    continue;
                }
                const uriString = addedFile.resource.toString();
                this.trackedTemplateURIs.add(uriString);
                const fileContent = await this.fileService.read(addedFile.resource);
                const parsed = this.parseTemplateWithMetadata(fileContent.value);
                let fragmentId;
                if (agentFolderURI) {
                    const stem = this.removePromptTemplateSuffix(addedFile.resource.path.name);
                    fragmentId = stem === exports.CUSTOM_AGENT_DEFAULT_PROMPT_STEM
                        ? await this.readCustomAgentDefaultFragmentId(agentFolderURI)
                        : stem;
                }
                else {
                    fragmentId = this.removePromptTemplateSuffix(addedFile.resource.path.name);
                }
                if (!fragmentId) {
                    continue;
                }
                this.addTemplate(this.activeCustomizations, fragmentId, parsed.template, uriString, this.allCustomizations, priority, customizationSource, parsed.metadata);
                changedFragmentIds.add(fragmentId);
            }
            const changedFragmentIdsArray = Array.from(changedFragmentIds);
            if (changedFragmentIdsArray.length > 0) {
                this.onDidChangePromptFragmentCustomizationEmitter.fire(changedFragmentIdsArray);
            }
        }));
    }
    /**
     * Checks if the given file extension is registered as a prompt template extension
     * @param extension The file extension including the leading dot (e.g., '.prompttemplate')
     * @returns True if the extension is registered as a prompt template extension
     */
    isPromptTemplateExtension(extension) {
        return this.templateExtensions.has(extension);
    }
    /**
     * Gets the list of additional template directories that are being watched.
     * @returns Array of directory paths
     */
    getAdditionalTemplateDirectories() {
        return Array.from(this.additionalTemplateDirs);
    }
    /**
     * Gets the list of file extensions that are considered prompt templates.
     * @returns Array of file extensions including the leading dot (e.g., '.prompttemplate')
     */
    getTemplateFileExtensions() {
        return Array.from(this.templateExtensions);
    }
    /**
     * Gets the list of specific template files that are being watched.
     * @returns Array of file paths
     */
    getTemplateFiles() {
        return Array.from(this.workspaceTemplateFiles);
    }
    /**
     * Updates multiple configuration properties at once, triggering only a single update process.
     * @param properties An object containing the properties to update
     * @returns Promise that resolves when the update is complete
     */
    async updateConfiguration(properties) {
        if (properties.directoryPaths !== undefined) {
            this.additionalTemplateDirs.clear();
            for (const path of properties.directoryPaths) {
                this.additionalTemplateDirs.add(path);
            }
        }
        if (properties.agentDirectoryPaths !== undefined) {
            this.customAgentDirs.clear();
            for (const path of properties.agentDirectoryPaths) {
                this.customAgentDirs.add(path);
            }
        }
        if (properties.extensions !== undefined) {
            this.templateExtensions.clear();
            for (const ext of properties.extensions) {
                this.templateExtensions.add(ext);
            }
            // Always include the default PROMPT_TEMPLATE_EXTENSION
            this.templateExtensions.add(prompttemplate_contribution_1.PROMPT_TEMPLATE_EXTENSION);
        }
        if (properties.filePaths !== undefined) {
            this.workspaceTemplateFiles.clear();
            for (const path of properties.filePaths) {
                this.workspaceTemplateFiles.add(path);
            }
        }
        // Only run the update process once, no matter how many properties were changed
        await this.update();
    }
    /**
     * Gets the URI of the templates directory
     * @returns URI of the templates directory
     */
    async getTemplatesDirectoryURI() {
        const templatesFolder = this.preferences[ai_core_preferences_1.PREFERENCE_NAME_PROMPT_TEMPLATES];
        if (templatesFolder && templatesFolder.trim().length > 0) {
            return core_1.URI.fromFilePath(templatesFolder);
        }
        const theiaConfigDir = await this.envVariablesServer.getConfigDirUri();
        return new core_1.URI(theiaConfigDir).resolve('prompt-templates');
    }
    /**
     * The additional (workspace) template directories as URIs, excluding any that resolves to the
     * same location as `excluding` (typically the global templates directory). A user can point
     * both the `promptTemplates` preference and a workspace template directory at the same path;
     * processing that scope twice would hide priority-1 customizations behind priority-2 copies
     * (see {@link update}) or list the same scope twice in the agent-location picker.
     */
    getDedupedAdditionalScopes(excluding) {
        const result = [];
        for (const dirPath of this.additionalTemplateDirs) {
            const dirURI = core_1.URI.fromFilePath(dirPath);
            if (!dirURI.isEqual(excluding)) {
                result.push(dirURI);
            }
        }
        return result;
    }
    /**
     * The deduplicated parent directories scanned for custom agents, in precedence order:
     * the built-in {@link customAgentDirs} (`.agents` then `.prompts`) first, so `.agents` is both
     * the discovery winner and the default creation target; then any configured
     * {@link additionalTemplateDirs} that may also hold agents; then the global templates directory.
     * Independent of the prompt-templates preference, mirroring how skills resolve their folders.
     */
    async getCustomAgentScopes() {
        const seen = new Set();
        const scopes = [];
        const add = (uri) => {
            const key = uri.toString();
            if (!seen.has(key)) {
                seen.add(key);
                scopes.push(uri);
            }
        };
        for (const dirPath of this.customAgentDirs) {
            add(core_1.URI.fromFilePath(dirPath));
        }
        for (const dirPath of this.additionalTemplateDirs) {
            add(core_1.URI.fromFilePath(dirPath));
        }
        add(await this.getTemplatesDirectoryURI());
        return scopes;
    }
    /**
     * Gets the URI for a specific template file
     * @param fragmentId The fragment ID
     * @returns URI for the template file
     */
    async getTemplateURI(fragmentId) {
        // Custom-agent default prompts live inside their own folder under the reserved filename
        // `prompt.prompttemplate`. Variants and other fragments fall back to scope-root behavior
        // (where filename = fragment id), matching how Theia tracks all other customizations.
        const agentFolder = this.customAgentFolderByFragmentId.get(fragmentId);
        if (agentFolder) {
            return agentFolder.resolve(`${exports.CUSTOM_AGENT_DEFAULT_PROMPT_STEM}${prompttemplate_contribution_1.PROMPT_TEMPLATE_EXTENSION}`);
        }
        return (await this.getTemplatesDirectoryURI()).resolve(`${fragmentId}${prompttemplate_contribution_1.PROMPT_TEMPLATE_EXTENSION}`);
    }
    /**
     * Removes the prompt template extension from a filename
     * @param filename The filename with extension
     * @returns The filename without the extension
     */
    removePromptTemplateSuffix(filename) {
        for (const ext of this.templateExtensions) {
            if (filename.endsWith(ext)) {
                return filename.slice(0, -ext.length);
            }
        }
        return filename;
    }
    // PromptFragmentCustomizationService interface implementation
    isPromptFragmentCustomized(id) {
        return this.activeCustomizations.has(id);
    }
    getActivePromptFragmentCustomization(id) {
        const entry = this.activeCustomizations.get(id);
        if (!entry) {
            return undefined;
        }
        return {
            id: entry.id,
            template: entry.template,
            customizationId: entry.customizationId,
            priority: entry.priority,
            // Pass through fragment metadata
            name: entry.name,
            description: entry.description,
            isCommand: entry.isCommand,
            commandName: entry.commandName,
            commandDescription: entry.commandDescription,
            commandArgumentHint: entry.commandArgumentHint,
            commandAgents: entry.commandAgents,
        };
    }
    getAllCustomizations(id) {
        const fragments = [];
        // Collect all customizations with matching ID
        this.allCustomizations.forEach(value => {
            if (value.id === id) {
                fragments.push({
                    id: value.id,
                    template: value.template,
                    customizationId: value.customizationId,
                    priority: value.priority,
                    // Pass through fragment metadata
                    name: value.name,
                    description: value.description,
                    isCommand: value.isCommand,
                    commandName: value.commandName,
                    commandDescription: value.commandDescription,
                    commandArgumentHint: value.commandArgumentHint,
                    commandAgents: value.commandAgents,
                });
            }
        });
        // Sort by priority (highest first)
        return fragments.sort((a, b) => b.priority - a.priority);
    }
    getCustomizedPromptFragmentIds() {
        return Array.from(this.activeCustomizations.keys());
    }
    async createPromptFragmentCustomization(id, defaultContent) {
        await this.editTemplate(id, defaultContent);
    }
    async createBuiltInPromptFragmentCustomization(id, defaultContent) {
        await this.createPromptFragmentCustomization(id, defaultContent);
    }
    async editPromptFragmentCustomization(id, customizationId) {
        // Find the customization with the given customization ID
        const customization = Array.from(this.allCustomizations.values()).find(t => t.id === id && t.customizationId === customizationId);
        if (customization) {
            const uri = new core_1.URI(customization.sourceUri);
            const openHandler = await this.openerService.getOpener(uri);
            openHandler.open(uri);
        }
        else {
            // Fall back to editing by fragment ID if customization ID not found
            await this.editTemplate(id);
        }
    }
    /**
     * Edits a template by opening it in the editor, creating it if it doesn't exist
     * @param id The fragment ID
     * @param defaultContent Optional default content for new templates
     */
    async editTemplate(id, defaultContent) {
        const editorUri = await this.getTemplateURI(id);
        if (await this.fileService.exists(editorUri)) {
            const openHandler = await this.openerService.getOpener(editorUri);
            openHandler.open(editorUri);
        }
        else {
            await this.openInMemoryTemplate(editorUri, defaultContent ?? '');
        }
    }
    /**
     * Opens an in-memory resource with the given content, without creating a file on disk.
     * The file is only created when the user saves in the editor.
     */
    async openInMemoryTemplate(templateUri, defaultContent) {
        try {
            this.inMemoryResources.resolve(templateUri);
        }
        catch {
            const resource = this.inMemoryResources.add(templateUri, {
                contents: defaultContent,
                initiallyDirty: false,
                onSave: async (contents) => {
                    const dirUri = templateUri.parent;
                    if (!(await this.fileService.exists(dirUri))) {
                        await this.fileService.createFolder(dirUri);
                    }
                    await this.fileService.createFile(templateUri, buffer_1.BinaryBuffer.fromString(contents), { overwrite: true });
                    resource.dispose();
                }
            });
        }
        const openHandler = await this.openerService.getOpener(templateUri);
        openHandler.open(templateUri);
    }
    async removePromptFragmentCustomization(id, customizationId) {
        // Find the customization with the given customization ID
        const customization = Array.from(this.allCustomizations.values()).find(t => t.id === id && t.customizationId === customizationId);
        if (customization) {
            const sourceUri = customization.sourceUri;
            // Delete the file if it exists
            const uri = new core_1.URI(sourceUri);
            if (await this.fileService.exists(uri)) {
                await this.fileService.delete(uri);
            }
        }
    }
    async removeAllPromptFragmentCustomizations(id) {
        // Get all customizations for this fragment ID
        const customizations = this.getAllCustomizations(id);
        if (customizations.length === 0) {
            return; // Nothing to reset
        }
        // Find and delete all customization files
        for (const customization of customizations) {
            const fragment = Array.from(this.allCustomizations.values()).find(t => t.id === id && t.customizationId === customization.customizationId);
            if (fragment) {
                const sourceUri = fragment.sourceUri;
                // Delete the file if it exists
                const uri = new core_1.URI(sourceUri);
                if (await this.fileService.exists(uri)) {
                    await this.fileService.delete(uri);
                }
            }
        }
    }
    async resetToCustomization(id, customizationId) {
        const customization = Array.from(this.allCustomizations.values()).find(t => t.id === id && t.customizationId === customizationId);
        if (customization) {
            // Get all customizations for this fragment ID
            const customizations = this.getAllCustomizations(id);
            if (customizations.length === 0) {
                return; // Nothing to reset
            }
            // Find the target customization
            const targetCustomization = customizations.find(c => c.customizationId === customizationId);
            if (!targetCustomization) {
                return; // Target customization not found
            }
            // Find and delete all higher-priority customization files
            for (const cust of customizations) {
                if (cust.priority > targetCustomization.priority) {
                    const fragmentToDelete = Array.from(this.allCustomizations.values()).find(t => t.id === cust.id && t.customizationId === cust.customizationId);
                    if (fragmentToDelete) {
                        const sourceUri = fragmentToDelete.sourceUri;
                        // Delete the file if it exists
                        const uri = new core_1.URI(sourceUri);
                        if (await this.fileService.exists(uri)) {
                            await this.fileService.delete(uri);
                        }
                    }
                }
            }
        }
    }
    async getPromptFragmentCustomizationDescription(id, customizationId) {
        // Find the customization with the given customization ID
        const customization = Array.from(this.allCustomizations.values()).find(t => t.id === id && t.customizationId === customizationId);
        if (customization) {
            return customization.sourceUri;
        }
        return undefined;
    }
    async getPromptFragmentCustomizationType(id, customizationId) {
        // Find the customization with the given customization ID
        const customization = Array.from(this.allCustomizations.values()).find(t => t.id === id && t.customizationId === customizationId);
        if (customization) {
            return getCustomizationSourceString(customization.origin);
        }
        return undefined;
    }
    async editBuiltIn(id, defaultContent = '') {
        // Find an existing built-in customization (those with priority 1)
        const builtInCustomization = Array.from(this.allCustomizations.values()).find(t => t.id === id && t.priority === 1);
        if (builtInCustomization) {
            // Edit the existing built-in customization
            const uri = new core_1.URI(builtInCustomization.sourceUri);
            const openHandler = await this.openerService.getOpener(uri);
            openHandler.open(uri);
        }
        else {
            // Open the built-in content without creating a file on disk.
            // The file will only be created when the user saves.
            const templateUri = await this.getTemplateURI(id);
            await this.openInMemoryTemplate(templateUri, defaultContent);
        }
    }
    async resetBuiltInCustomization(id) {
        // Find a built-in customization (those with priority 1)
        const builtInCustomization = Array.from(this.allCustomizations.values()).find(t => t.id === id && t.priority === 1);
        if (!builtInCustomization) {
            return; // No built-in customization found
        }
        const sourceUri = builtInCustomization.sourceUri;
        // Delete the file if it exists
        const uri = new core_1.URI(sourceUri);
        if (await this.fileService.exists(uri)) {
            await this.fileService.delete(uri);
        }
    }
    async editBuiltInPromptFragmentCustomization(id, defaultContent) {
        return this.editBuiltIn(id, defaultContent);
    }
    /**
     * Gets the fragment ID from a URI
     * @param uri URI to check
     * @returns Fragment ID or undefined if not found
     */
    getFragmentIDFromURI(uri) {
        const id = this.removePromptTemplateSuffix(uri.path.name);
        if (this.activeCustomizations.has(id)) {
            return id;
        }
        return undefined;
    }
    /**
     * Implementation of the generic getPromptFragmentIDFromResource method in the interface
     * Accepts any resource identifier but only processes URIs
     * @param resourceId Resource to check
     * @returns Fragment ID or undefined if not found
     */
    getPromptFragmentIDFromResource(resourceId) {
        // Check if the resource is a URI
        if (resourceId instanceof core_1.URI) {
            return this.getFragmentIDFromURI(resourceId);
        }
        return undefined;
    }
    async getCustomAgents() {
        const agentsById = new Map();
        // Process scopes in precedence order (`.agents`/`.prompts` first, global last). The map only
        // keeps the first agent seen per id, so earlier scopes win on conflicts.
        for (const scope of await this.getCustomAgentScopes()) {
            await this.loadCustomAgentsFromAgentsDirectory(scope, agentsById);
            await this.loadCustomAgentsFromDirectory(scope, agentsById);
        }
        // Note: customAgentFolderByFragmentId is intentionally not cleared here. It grows
        // monotonically — stale entries (renamed/removed agents) at worst point at a folder
        // that no longer exists, which the file-create path mkdirps if needed. Clearing it
        // up front would create a race where a concurrent `getTemplateURI` call sees an empty
        // map and falls back to the scope root.
        return Array.from(agentsById.values());
    }
    /**
     * Load custom agents from `<parentDirectory>/agents/<id>/agent.md`. Each immediate
     * subdirectory under `agents/` defines one custom agent: the folder name is the
     * agent id (single source of truth), the file's YAML frontmatter holds the metadata,
     * and the body is the prompt text. Folders without a readable `agent.md` are skipped.
     */
    async loadCustomAgentsFromAgentsDirectory(parentDirectory, agentsById) {
        const agentsDirURI = parentDirectory.resolve(exports.CUSTOM_AGENTS_DIRECTORY);
        let directoryStat;
        try {
            directoryStat = await this.fileService.resolve(agentsDirURI);
        }
        catch {
            return;
        }
        if (!directoryStat.isDirectory || !directoryStat.children?.length) {
            return;
        }
        for (const child of directoryStat.children) {
            if (!child.isDirectory) {
                continue;
            }
            const agent = await this.readCustomAgentFile(child.resource);
            if (!agent) {
                continue;
            }
            if (!agentsById.has(agent.id)) {
                agentsById.set(agent.id, agent);
            }
        }
    }
    async readCustomAgentFile(agentFolderURI) {
        const id = agentFolderURI.path.base;
        const fileURI = agentFolderURI.resolve(exports.CUSTOM_AGENT_FILE_NAME);
        let content;
        try {
            content = (await this.fileService.read(fileURI, { encoding: 'utf-8' })).value;
        }
        catch {
            return undefined;
        }
        const { metadata, body } = (0, frontmatter_1.parseFrontmatter)(content, { isValid: CustomAgentFrontmatter.is });
        if (!metadata) {
            this.logger.debug(`Invalid or missing frontmatter in ${fileURI.toString()}`);
            return undefined;
        }
        if (metadata.id !== undefined && metadata.id !== id) {
            this.logger.debug(`Frontmatter id '${metadata.id}' in ${fileURI.toString()} does not match folder name '${id}'. Skipping.`);
            return undefined;
        }
        const promptVariants = await this.readCustomAgentPromptVariants(agentFolderURI);
        const fragmentId = `${metadata.name}_prompt`;
        this.customAgentFolderByFragmentId.set(fragmentId, agentFolderURI);
        return {
            id,
            name: metadata.name,
            description: metadata.description,
            prompt: body,
            defaultLLM: metadata.defaultLLM,
            showInChat: metadata.showInChat,
            ...(promptVariants.length > 0 ? { promptVariants } : {})
        };
    }
    /**
     * Remove `<scopeDir>/agents/<id>/` directories that contain no `agent.md`. They are usually
     * the leftover side effect of a previous migration whose `agent.md` write failed after the
     * parent directory had already been created. Removing them lets the next run re-attempt.
     */
    async cleanupEmptyAgentFolders(scopeDir) {
        const agentsDirURI = scopeDir.resolve(exports.CUSTOM_AGENTS_DIRECTORY);
        let stat;
        try {
            stat = await this.fileService.resolve(agentsDirURI);
        }
        catch {
            return;
        }
        if (!stat.children?.length) {
            return;
        }
        for (const child of stat.children) {
            if (!child.isDirectory) {
                continue;
            }
            const agentMdURI = child.resource.resolve(exports.CUSTOM_AGENT_FILE_NAME);
            if (await this.fileService.exists(agentMdURI)) {
                continue;
            }
            const childStat = await this.fileService.resolve(child.resource).catch(() => undefined);
            if (childStat?.children?.length) {
                continue;
            }
            try {
                await this.fileService.delete(child.resource, { recursive: true });
                this.logger.info(`Removed empty agent folder ${child.resource.toString()} left behind by a previous run.`);
            }
            catch (e) {
                this.logger.warn(`Failed to remove empty agent folder ${child.resource.toString()}: ${e?.message ?? e}`);
            }
        }
    }
    /**
     * List `.prompttemplate` files directly inside the given scope directory (one level only).
     * Returns each file's URI along with its filename stem to enable cheap prefix matching
     * during migration.
     */
    async listScopeRootPromptTemplates(scopeDir) {
        let stat;
        try {
            stat = await this.fileService.resolve(scopeDir);
        }
        catch {
            return [];
        }
        if (!stat.children?.length) {
            return [];
        }
        const result = [];
        for (const child of stat.children) {
            if (!child.isFile) {
                continue;
            }
            if (!this.isPromptTemplateExtension(child.resource.path.ext)) {
                continue;
            }
            result.push({ uri: child.resource, stem: this.removePromptTemplateSuffix(child.resource.path.name) });
        }
        return result;
    }
    /**
     * Scan an agent folder for sibling `.prompttemplate` files; each becomes a variant
     * of the agent's prompt. Variant id = filename stem (e.g. `concise.prompttemplate`
     * yields a variant with id `concise`). Files inside subdirectories are ignored.
     *
     * The reserved filename `prompt.prompttemplate` is excluded: it represents the
     * default-variant customization (overrides `agent.md`'s body), not an extra variant,
     * and is registered by the prompt-fragment customization scan instead.
     */
    async readCustomAgentPromptVariants(agentFolderURI) {
        let folderStat;
        try {
            folderStat = await this.fileService.resolve(agentFolderURI);
        }
        catch {
            return [];
        }
        if (!folderStat.children?.length) {
            return [];
        }
        const variants = [];
        for (const child of folderStat.children) {
            if (!child.isFile) {
                continue;
            }
            if (!this.isPromptTemplateExtension(child.resource.path.ext)) {
                continue;
            }
            const variantId = this.removePromptTemplateSuffix(child.resource.path.name);
            if (variantId === exports.CUSTOM_AGENT_DEFAULT_PROMPT_STEM) {
                continue;
            }
            try {
                const variantContent = (await this.fileService.read(child.resource, { encoding: 'utf-8' })).value;
                const parsed = this.parseTemplateWithMetadata(variantContent);
                variants.push({ id: variantId, template: parsed.template });
            }
            catch (e) {
                this.logger.debug(`Failed to read prompt variant ${child.resource.toString()}: ${e?.message ?? e}`);
            }
        }
        // Stable order to keep equality checks deterministic between loads.
        variants.sort((a, b) => a.id.localeCompare(b.id));
        return variants;
    }
    /**
     * @deprecated Reads legacy `customAgents.yml` files. New agents should live under
     * `<scope>/agents/<id>/agent.md`. Kept as a fallback until existing files have been
     * auto-migrated; loader logs a one-time warning per scope when it finds one.
     */
    async loadCustomAgentsFromDirectory(directoryURI, agentsById) {
        const customAgentYamlUri = directoryURI.resolve('customAgents.yml');
        const yamlExists = await this.fileService.exists(customAgentYamlUri);
        if (!yamlExists) {
            return;
        }
        this.warnOnceLegacyYaml(customAgentYamlUri);
        try {
            const fileContent = await this.fileService.read(customAgentYamlUri, { encoding: 'utf-8' });
            const doc = this.parseCustomAgentsYaml(fileContent.value);
            if (!Array.isArray(doc) || !doc.every(entry => common_1.CustomAgentDescription.is(entry))) {
                this.logger.debug(`Invalid customAgents.yml file content in ${directoryURI.toString()}`);
                return;
            }
            const readAgents = doc;
            // Add agents to the map if they don't already exist
            for (const agent of readAgents) {
                if (!agentsById.has(agent.id)) {
                    agentsById.set(agent.id, agent);
                }
            }
        }
        catch (e) {
            this.logger.debug(`Error loading customAgents.yml from ${directoryURI.toString()}: ${e.message}`, e);
        }
    }
    warnOnceLegacyYaml(uri) {
        const key = uri.toString();
        if (this.warnedLegacyYamlUris.has(key)) {
            return;
        }
        this.warnedLegacyYamlUris.add(key);
        this.logger.warn(`Loading custom agents from legacy '${key}'. ` +
            `Files in this format are auto-migrated to the '${exports.CUSTOM_AGENTS_DIRECTORY}/' folder on startup. ` +
            'If migration did not run, invoke the command \'AI: Re-run custom-agent migration\'.');
    }
    /**
     * Returns all locations of existing customAgents.yml files and `agents/` directories,
     * plus the canonical locations where new agents would be created (one per scope). Scopes are
     * returned in precedence order, so the first `agents-dir` entry is the default creation target.
     */
    async getCustomAgentsLocations() {
        const locations = [];
        for (const parentDir of await this.getCustomAgentScopes()) {
            const agentsDirURI = parentDir.resolve(exports.CUSTOM_AGENTS_DIRECTORY);
            locations.push({ uri: agentsDirURI, exists: await this.fileService.exists(agentsDirURI), kind: 'agents-dir' });
            const yamlURI = parentDir.resolve('customAgents.yml');
            locations.push({ uri: yamlURI, exists: await this.fileService.exists(yamlURI), kind: 'legacy-yaml' });
        }
        return locations;
    }
    /**
     * Creates `<parentDirectory>/agents/<id>/agent.md` from a `CustomAgentDescription` and opens it.
     * The agent id determines the folder name; the prompt body is written verbatim under the YAML frontmatter.
     */
    async createCustomAgentFile(parentDirectory, agent) {
        const fileURI = parentDirectory.resolve(exports.CUSTOM_AGENTS_DIRECTORY).resolve(agent.id).resolve(exports.CUSTOM_AGENT_FILE_NAME);
        const content = serializeCustomAgentFile(agent);
        if (!(await this.fileService.exists(fileURI))) {
            await this.fileService.createFile(fileURI, buffer_1.BinaryBuffer.fromString(content));
        }
        else {
            await this.fileService.writeFile(fileURI, buffer_1.BinaryBuffer.fromString(content));
        }
        const openHandler = await this.openerService.getOpener(fileURI);
        openHandler.open(fileURI);
        return fileURI;
    }
    /**
     * Parse a `customAgents.yml` document, preserving newlines in folded-block-scalar prompts.
     *
     * `js-yaml` folds the single newlines of a folded scalar (`>` / `>-`) into spaces, which merges
     * a markdown heading (`## Task`) into the paragraph below it. Markdown is newline-sensitive, so
     * we re-interpret folded `prompt:` scalars as literal (`|`) before parsing. Only the block-scalar
     * header is rewritten; quoted, plain and already-literal values are left untouched.
     *
     * Known limitation: prompts stored as a plain or quoted multi-line scalar (rare) still fold.
     */
    parseCustomAgentsYaml(content) {
        return (0, js_yaml_1.load)(this.unfoldPromptBlockScalars(content));
    }
    /**
     * Rewrite a folded `prompt:` block-scalar header (`>`, `>-`, `>+`, `>2-`, ...) to its literal
     * equivalent (`|`...). The lookahead ensures only a block-scalar header is matched (indentation
     * and chomping indicators plus an optional trailing comment), so plain/quoted prompt values and
     * any `>` inside the prompt body are never touched.
     */
    unfoldPromptBlockScalars(content) {
        return content.replace(/^([ \t]*prompt:[ \t]*)>(?=[-+0-9]*[ \t]*(?:#.*)?$)/mg, '$1|');
    }
    /**
     * Returns `true` if migration would write anything: a scope still holds a legacy
     * `customAgents.yml`, or a previously migrated scope has `agent.md` files that can be corrected
     * (see {@link computeScopeCorrections}). Read-only; used to decide whether to prompt the user.
     */
    async hasPendingCustomAgentMigration() {
        for (const scope of await this.getCustomAgentScopes()) {
            if (await this.fileService.exists(scope.resolve('customAgents.yml'))) {
                return true;
            }
            if ((await this.computeScopeCorrections(scope)).length > 0) {
                return true;
            }
        }
        return false;
    }
    /**
     * Auto-migrate every legacy `customAgents.yml` reachable from the configured scopes to the new
     * `agents/<id>/agent.md` layout. The original content is never deleted:
     * - on full success the YAML is renamed to `customAgents.yml.bak`, replacing any previous backup;
     * - on partial failure the YAML is renamed to `customAgents.yml.bak` only if no backup exists yet;
     *   if one already exists the YAML is left in place, so the loader keeps serving it and the next
     *   startup retries the migration.
     *
     * Idempotent: rerunning never overwrites an already-migrated agent file.
     */
    async migrateCustomAgentsYaml() {
        // Coalesce concurrent calls. refreshCustomAgents() can re-fire during startup when
        // additionalTemplateDirs is populated asynchronously; without this guard each call
        // launches a parallel migration that races on the same `customAgents.yml` and on
        // sibling `*_prompt*.prompttemplate` files.
        if (this.migrationInFlight) {
            return this.migrationInFlight;
        }
        this.migrationInFlight = this.doMigrateCustomAgentsYaml().finally(() => {
            this.migrationInFlight = undefined;
        });
        return this.migrationInFlight;
    }
    async doMigrateCustomAgentsYaml() {
        const scopes = await this.getCustomAgentScopes();
        const reports = [];
        for (const scope of scopes) {
            const report = await this.migrateSingleScope(scope);
            if (report) {
                reports.push(report);
            }
        }
        if (reports.some(r => r.migrated > 0 || r.corrected > 0)) {
            this.onDidChangeCustomAgentsEmitter.fire();
        }
        return reports;
    }
    async migrateSingleScope(scopeDir) {
        const yamlURI = scopeDir.resolve('customAgents.yml');
        const backupURI = scopeDir.resolve('customAgents.yml.bak');
        const yamlExists = await this.fileService.exists(yamlURI);
        let migrated = 0;
        let alreadyPresent = 0;
        let failed = 0;
        let promptOverridesMigrated = 0;
        let yamlBackedUp = false;
        const emptyReport = () => ({
            scope: scopeDir, yamlURI, migrated: 0, alreadyPresent: 0, failed: 0,
            yamlBackedUp: false, promptOverridesMigrated: 0, corrected: 0
        });
        if (yamlExists) {
            this.logger.info(`Migrating custom agents from ${yamlURI.toString()}`);
            let entries;
            try {
                const fileContent = await this.fileService.read(yamlURI, { encoding: 'utf-8' });
                const doc = this.parseCustomAgentsYaml(fileContent.value);
                if (!Array.isArray(doc) || !doc.every(common_1.CustomAgentDescription.is)) {
                    this.logger.warn(`Skipping migration of ${yamlURI.toString()}: file content is not a valid CustomAgentDescription[]`);
                    return emptyReport();
                }
                entries = doc;
            }
            catch (e) {
                this.logger.warn(`Skipping migration of ${yamlURI.toString()}: ${e.message}`);
                return emptyReport();
            }
            // A previous failed migration may have created `agents/<id>/` directories without an
            // `agent.md` inside. Remove those empty placeholders so this run can recreate them cleanly.
            await this.cleanupEmptyAgentFolders(scopeDir);
            // Snapshot scope-root template files once so we can match per agent without re-listing.
            const scopeRootTemplateFiles = await this.listScopeRootPromptTemplates(scopeDir);
            // Prompt-fragment files are matched by agent *name* (the fragment id is `<name>_prompt`)
            // while folders are keyed by the unique *id*. When two entries share a name, only the first
            // can own the name-based files, so track seen names and skip the move for the duplicates.
            const seenNames = new Set();
            for (const entry of entries) {
                const agentFolderURI = scopeDir.resolve(exports.CUSTOM_AGENTS_DIRECTORY).resolve(entry.id);
                const targetURI = agentFolderURI.resolve(exports.CUSTOM_AGENT_FILE_NAME);
                if (await this.fileService.exists(targetURI)) {
                    alreadyPresent++;
                }
                else {
                    try {
                        await this.fileService.createFile(targetURI, buffer_1.BinaryBuffer.fromString(serializeCustomAgentFile(entry)), { overwrite: true });
                        migrated++;
                    }
                    catch (e) {
                        this.logger.warn(`Failed to migrate agent '${entry.id}' from ${yamlURI.toString()}: ${e?.message ?? e}`, e);
                        failed++;
                        continue;
                    }
                }
                if (seenNames.has(entry.name)) {
                    this.logger.warn(`Multiple custom agents in ${yamlURI.toString()} share the name '${entry.name}'; ` +
                        'prompt fragment files were migrated to the first matching agent only.');
                    continue;
                }
                seenNames.add(entry.name);
                // Move any scope-root .prompttemplate files that look like they belong to this agent
                // (filename stem starts with `<name>_prompt`, followed by EOF or a separator).
                // They become variants under `<scope>/agents/<id>/`.
                for (const file of scopeRootTemplateFiles) {
                    if (!matchesAgentPromptPrefix(file.stem, entry.name)) {
                        continue;
                    }
                    const destURI = agentFolderURI.resolve(file.uri.path.base);
                    if (await this.fileService.exists(destURI)) {
                        continue;
                    }
                    try {
                        await this.fileService.move(file.uri, destURI);
                        promptOverridesMigrated++;
                    }
                    catch (e) {
                        this.logger.warn(`Failed to move prompt fragment ${file.uri.toString()} into ${destURI.toString()}: ${e?.message ?? e}`);
                    }
                }
            }
            if (failed === 0) {
                try {
                    await this.fileService.move(yamlURI, backupURI, { overwrite: true });
                    yamlBackedUp = true;
                }
                catch (e) {
                    this.logger.warn(`Migrated ${migrated} agents but failed to back up ${yamlURI.toString()}: ${e.message}`);
                }
            }
            else {
                try {
                    if (!(await this.fileService.exists(backupURI))) {
                        await this.fileService.move(yamlURI, backupURI);
                        yamlBackedUp = true;
                    }
                }
                catch (e) {
                    this.logger.warn(`Failed to back up ${yamlURI.toString()} to ${backupURI.toString()}: ${e.message}`);
                }
            }
        }
        // Correct any `agent.md` left with merged headings by an earlier (v1.73.0) migration. Anything
        // just migrated above is already correct, so only stale files from a previous run are rewritten.
        let corrected = 0;
        for (const { uri, content } of await this.computeScopeCorrections(scopeDir)) {
            try {
                await this.fileService.createFile(uri, buffer_1.BinaryBuffer.fromString(content), { overwrite: true });
                corrected++;
            }
            catch (e) {
                this.logger.warn(`Failed to correct migrated agent file ${uri.toString()}: ${e?.message ?? e}`);
            }
        }
        if (!yamlExists && corrected === 0) {
            return undefined; // nothing to migrate and nothing to correct in this scope
        }
        this.logger.info(`Migration done for ${scopeDir.toString()}: migrated=${migrated}, alreadyPresent=${alreadyPresent}, ` +
            `failed=${failed}, yamlBackedUp=${yamlBackedUp}, promptOverridesMigrated=${promptOverridesMigrated}, corrected=${corrected}`);
        return { scope: scopeDir, yamlURI, migrated, alreadyPresent, failed, yamlBackedUp, promptOverridesMigrated, corrected };
    }
    /**
     * Compute the `agent.md` rewrites needed to recover headings folded by an earlier (v1.73.0)
     * migration. The backup (`customAgents.yml.bak`) is the source that migration used: parsing it
     * the old (folded) way reproduces the exact bytes it wrote, and parsing it the new (literal) way
     * produces the corrected content. Only files still byte-identical to the buggy output are eligible,
     * so files the user edited (and already-correct files) are left untouched. Read-only; used both to
     * detect pending work and to perform the rewrite.
     */
    async computeScopeCorrections(scopeDir) {
        const backupURI = scopeDir.resolve('customAgents.yml.bak');
        if (!(await this.fileService.exists(backupURI))) {
            return [];
        }
        let oldEntries;
        let newEntries;
        try {
            const raw = (await this.fileService.read(backupURI, { encoding: 'utf-8' })).value;
            oldEntries = (0, js_yaml_1.load)(raw); // reproduces the folded (buggy) output
            newEntries = this.parseCustomAgentsYaml(raw); // produces the heading-preserving fix
        }
        catch {
            return [];
        }
        if (!Array.isArray(oldEntries) || !oldEntries.every(common_1.CustomAgentDescription.is)
            || !Array.isArray(newEntries) || !newEntries.every(common_1.CustomAgentDescription.is)) {
            return [];
        }
        const fixedById = new Map(newEntries.map(e => [e.id, e]));
        const corrections = [];
        for (const oldEntry of oldEntries) {
            const fixed = fixedById.get(oldEntry.id);
            if (!fixed) {
                continue;
            }
            const buggyContent = serializeCustomAgentFile(oldEntry);
            const fixedContent = serializeCustomAgentFile(fixed);
            if (buggyContent === fixedContent) {
                continue; // prompt had no folded headings to recover
            }
            const agentMdURI = scopeDir.resolve(exports.CUSTOM_AGENTS_DIRECTORY).resolve(oldEntry.id).resolve(exports.CUSTOM_AGENT_FILE_NAME);
            if (!(await this.fileService.exists(agentMdURI))) {
                continue;
            }
            let current;
            try {
                current = (await this.fileService.read(agentMdURI, { encoding: 'utf-8' })).value;
            }
            catch {
                continue;
            }
            // Only rewrite files untouched since migration; current bytes still matching the buggy output.
            if (current === buggyContent) {
                corrections.push({ uri: agentMdURI, content: fixedContent });
            }
        }
        return corrections;
    }
    /**
     * @deprecated Use {@link createCustomAgentFile} to author agents in the new
     * `<scope>/agents/<id>/agent.md` layout. Retained so existing UI affordances keep
     * working until they are migrated.
     */
    async openCustomAgentYaml(uri) {
        const content = (0, js_yaml_1.dump)([newCustomAgentEntry]);
        if (!await this.fileService.exists(uri)) {
            await this.fileService.createFile(uri, buffer_1.BinaryBuffer.fromString(content));
        }
        else {
            const fileContent = (await this.fileService.readFile(uri)).value;
            await this.fileService.writeFile(uri, buffer_1.BinaryBuffer.concat([fileContent, buffer_1.BinaryBuffer.fromString(content)]));
        }
        const openHandler = await this.openerService.getOpener(uri);
        openHandler.open(uri);
    }
};
exports.DefaultPromptFragmentCustomizationService = DefaultPromptFragmentCustomizationService;
tslib_1.__decorate([
    (0, inversify_1.inject)(env_variables_1.EnvVariablesServer),
    tslib_1.__metadata("design:type", Object)
], DefaultPromptFragmentCustomizationService.prototype, "envVariablesServer", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(ai_core_preferences_1.AICorePreferences),
    tslib_1.__metadata("design:type", Object)
], DefaultPromptFragmentCustomizationService.prototype, "preferences", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(file_service_1.FileService),
    tslib_1.__metadata("design:type", file_service_1.FileService)
], DefaultPromptFragmentCustomizationService.prototype, "fileService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.OpenerService),
    tslib_1.__metadata("design:type", Object)
], DefaultPromptFragmentCustomizationService.prototype, "openerService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(configurable_in_memory_resources_1.ConfigurableInMemoryResources),
    tslib_1.__metadata("design:type", configurable_in_memory_resources_1.ConfigurableInMemoryResources)
], DefaultPromptFragmentCustomizationService.prototype, "inMemoryResources", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_2.WorkspaceService),
    tslib_1.__metadata("design:type", browser_2.WorkspaceService)
], DefaultPromptFragmentCustomizationService.prototype, "workspaceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('ai-core:DefaultPromptFragmentCustomizationService'),
    tslib_1.__metadata("design:type", Object)
], DefaultPromptFragmentCustomizationService.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], DefaultPromptFragmentCustomizationService.prototype, "init", null);
exports.DefaultPromptFragmentCustomizationService = DefaultPromptFragmentCustomizationService = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], DefaultPromptFragmentCustomizationService);
/**
 * Returns true when a filename stem looks like a prompt fragment owned by the named agent —
 * i.e. it begins with `<name>_prompt` followed by end-of-string or a separator
 * (`-`, `_`, ` `, `.`). Used to scoop variant files like `Foo_prompt_old.prompttemplate` into
 * the agent's folder during migration without grabbing unrelated fragments such as
 * `FooBar_prompt.prompttemplate` for a different agent.
 */
function matchesAgentPromptPrefix(stem, agentName) {
    const prefix = `${agentName}_prompt`;
    if (!stem.startsWith(prefix)) {
        return false;
    }
    const next = stem.charAt(prefix.length);
    return next === '' || next === '-' || next === '_' || next === ' ' || next === '.';
}
function serializeCustomAgentFile(agent) {
    const metadata = {
        name: agent.name,
        description: agent.description,
        defaultLLM: agent.defaultLLM,
    };
    if (agent.showInChat !== undefined) {
        metadata.showInChat = agent.showInChat;
    }
    return (0, frontmatter_1.serializeFrontmatter)(metadata, agent.prompt);
}
//# sourceMappingURL=frontend-prompt-customization-service.js.map