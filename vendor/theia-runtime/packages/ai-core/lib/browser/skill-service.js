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
exports.DefaultSkillService = exports.SkillService = exports.SkillDirectoryContribution = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const promise_util_1 = require("@theia/core/lib/common/promise-util");
const core_1 = require("@theia/core");
const path_1 = require("@theia/core/lib/common/path");
const env_variables_1 = require("@theia/core/lib/common/env-variables");
const file_service_1 = require("@theia/filesystem/lib/browser/file-service");
const browser_1 = require("@theia/workspace/lib/browser");
const ai_core_preferences_1 = require("../common/ai-core-preferences");
const skill_1 = require("../common/skill");
/** Debounce delay for coalescing rapid file system events */
const UPDATE_DEBOUNCE_MS = 50;
exports.SkillDirectoryContribution = Symbol('SkillDirectoryContribution');
exports.SkillService = Symbol('SkillService');
let DefaultSkillService = class DefaultSkillService {
    constructor() {
        /** Keyed by {@link Skill.qualifiedName}. */
        this.skills = new Map();
        /** Watchers of the current scan; disposed and rebuilt on every rescan. */
        this.toDispose = new core_1.DisposableCollection();
        /** Kept apart from {@link toDispose}, which does not survive a rescan. */
        this.toDisposeOnServiceDispose = new core_1.DisposableCollection();
        this.watchedDirectories = new Set();
        this.parentWatchers = new Map();
        this.onSkillsChangedEmitter = new core_1.Emitter();
        this.onSkillsChanged = this.onSkillsChangedEmitter.event;
        /** True while {@link update} is running, so concurrent callers do not duplicate the scan and its log output. */
        this.updateInProgress = false;
        /** Set when {@link update} is called while another run is in progress; triggers a follow-up scan when the current one finishes. */
        this.updateRescheduled = false;
        this._ready = new promise_util_1.Deferred();
    }
    get ready() {
        return this._ready.promise;
    }
    init() {
        for (const contribution of this.skillDirectoryContributions.getContributions()) {
            if (contribution.onDidChange) {
                this.toDisposeOnServiceDispose.push(contribution.onDidChange(() => this.scheduleUpdate()));
            }
        }
        this.fileService.onDidFilesChange(async (event) => {
            for (const change of event.changes) {
                if (change.type === 1 /* FileChangeType.ADDED */) {
                    const changeUri = change.resource.toString();
                    for (const [, skillsPath] of this.parentWatchers) {
                        const expectedSkillsUri = core_1.URI.fromFilePath(skillsPath).toString();
                        if (changeUri === expectedSkillsUri) {
                            this.scheduleUpdate();
                            return;
                        }
                    }
                }
                // Check for skills directory deletion - switch back to parent watching
                if (change.type === 2 /* FileChangeType.DELETED */) {
                    const changeUri = change.resource.toString();
                    if (this.watchedDirectories.has(changeUri)) {
                        this.scheduleUpdate();
                        return;
                    }
                }
            }
            const isRelevantChange = event.changes.some(change => {
                const changeUri = change.resource.toString();
                const isInWatchedDir = Array.from(this.watchedDirectories).some(dirUri => changeUri.startsWith(dirUri));
                if (!isInWatchedDir) {
                    return false;
                }
                // Trigger on SKILL.md changes or directory additions/deletions
                const isSkillFile = change.resource.path.base === skill_1.SKILL_FILE_NAME;
                const isDirectoryChange = change.type === 1 /* FileChangeType.ADDED */ || change.type === 2 /* FileChangeType.DELETED */;
                return isSkillFile || isDirectoryChange;
            });
            if (isRelevantChange) {
                this.scheduleUpdate();
            }
        });
        this.initializeSkills();
    }
    /** Runs the initial scan once the skill directory sources are known. {@link ready} always resolves, even if the scan failed. */
    async initializeSkills() {
        try {
            // The workspace contributes the workspace skill directories, the preferences the configured ones.
            await Promise.all([this.workspaceService.ready, this.preferences.ready]);
        }
        catch (error) {
            this.logger.error('Failed to resolve skill directory sources, scanning the already known directories', error);
        }
        // Listen for changes before the initial scan, otherwise a change landing while it runs is recorded as
        // already applied by the snapshot below and dropped. update()'s in-progress guard coalesces the overlap.
        this.lastSkillDirectoriesValue = JSON.stringify(this.preferences[ai_core_preferences_1.PREFERENCE_NAME_SKILL_DIRECTORIES]);
        this.preferences.onPreferenceChanged(event => {
            if (event.preferenceName === ai_core_preferences_1.PREFERENCE_NAME_SKILL_DIRECTORIES) {
                const currentValue = JSON.stringify(this.preferences[ai_core_preferences_1.PREFERENCE_NAME_SKILL_DIRECTORIES]);
                if (currentValue === this.lastSkillDirectoriesValue) {
                    return;
                }
                this.lastSkillDirectoriesValue = currentValue;
                this.scheduleUpdate();
            }
        });
        this.workspaceService.onWorkspaceChanged(() => {
            this.scheduleUpdate();
        });
        try {
            await this.update();
        }
        catch (error) {
            this.logger.error('Initial skill scan failed', error);
        }
        this._ready.resolve();
    }
    getSkills() {
        return Array.from(this.skills.values());
    }
    getSkill(name) {
        const qualifiedMatch = this.skills.get(name);
        if (qualifiedMatch) {
            return qualifiedMatch;
        }
        // Ambiguous plain names resolve to nothing: guessing would silently load a skill the caller
        // did not ask for.
        const plainMatches = this.getSkills().filter(skill => skill.name === name);
        return plainMatches.length === 1 ? plainMatches[0] : undefined;
    }
    dispose() {
        this.toDisposeOnServiceDispose.dispose();
        this.toDispose.dispose();
    }
    scheduleUpdate() {
        if (this.updateDebounceTimeout) {
            clearTimeout(this.updateDebounceTimeout);
        }
        this.updateDebounceTimeout = setTimeout(() => {
            this.updateDebounceTimeout = undefined;
            this.update();
        }, UPDATE_DEBOUNCE_MS);
    }
    async update() {
        if (this.updateDebounceTimeout) {
            clearTimeout(this.updateDebounceTimeout);
            this.updateDebounceTimeout = undefined;
        }
        // Serialise concurrent update() calls: a workspace-ready trigger and a file-change-driven
        // scheduleUpdate() can fire within the same async tick, in which case both runs would
        // scan and log everything, producing the duplicated log lines that motivated this guard.
        // The second caller records a pending request and lets the first finish; the follow-up
        // is then re-scheduled through the debouncer so any further events coalesce into it.
        if (this.updateInProgress) {
            this.updateRescheduled = true;
            return;
        }
        this.updateInProgress = true;
        try {
            await this.doUpdate();
        }
        finally {
            this.updateInProgress = false;
            if (this.updateRescheduled) {
                this.updateRescheduled = false;
                this.scheduleUpdate();
            }
        }
    }
    async doUpdate() {
        this.toDispose.dispose();
        const newDisposables = new core_1.DisposableCollection();
        const newSkills = new Map();
        const workspaceSkillsDirs = this.getWorkspaceSkillsDirectoryPaths();
        const homeDirUri = await this.envVariablesServer.getHomeDirUri();
        const homePath = new core_1.URI(homeDirUri).path.fsPath();
        const configuredDirectories = (this.preferences[ai_core_preferences_1.PREFERENCE_NAME_SKILL_DIRECTORIES] ?? [])
            .map(dir => path_1.Path.untildify(dir, homePath));
        const defaultSkillsDirs = await this.getDefaultSkillsDirectoryPaths();
        const pluginSkillsDirs = await this.getContributedSkillDirectories();
        const newWatchedDirectories = new Set();
        const newParentWatchers = new Map();
        const allDirectories = (0, skill_1.combineSkillDirectories)(workspaceSkillsDirs, configuredDirectories, defaultSkillsDirs, pluginSkillsDirs);
        for (const { path: directoryPath, tier, qualifier } of allDirectories) {
            if (tier === 'configured') {
                await this.processConfiguredSkillDirectory(directoryPath, newSkills, newDisposables, newWatchedDirectories, qualifier);
            }
            else {
                // `plugin` roots take this path too: a plugin with no `skills` directory is a
                // plugin without skills, worth watching for rather than warning about.
                await this.processSkillDirectoryWithParentWatching(directoryPath, newSkills, newDisposables, newWatchedDirectories, newParentWatchers, qualifier);
            }
        }
        if (newSkills.size > 0 && newSkills.size !== this.skills.size) {
            this.logger.info(`Loaded ${newSkills.size} skills`);
        }
        this.toDispose = newDisposables;
        this.skills = newSkills;
        this.watchedDirectories = newWatchedDirectories;
        this.parentWatchers = newParentWatchers;
        this.onSkillsChangedEmitter.fire();
    }
    /** A failing contribution is skipped: one broken root must not cost every other skill. */
    async getContributedSkillDirectories() {
        const entries = [];
        for (const contribution of this.skillDirectoryContributions.getContributions()) {
            try {
                entries.push(...await contribution.getSkillDirectories());
            }
            catch (error) {
                this.logger.error(`Failed to collect contributed skill directories: ${error}`);
            }
        }
        return entries;
    }
    getWorkspaceSkillsDirectoryPaths() {
        return this.workspaceService.tryGetRoots().flatMap(root => [
            root.resource.resolve('.prompts/skills').path.fsPath(),
            root.resource.resolve('.agents/skills').path.fsPath()
        ]);
    }
    async getDefaultSkillsDirectoryPaths() {
        const configDirUri = await this.envVariablesServer.getConfigDirUri();
        const configDir = new core_1.URI(configDirUri);
        const homeDirUri = await this.envVariablesServer.getHomeDirUri();
        const homeDir = new core_1.URI(homeDirUri);
        return [
            configDir.resolve('skills').path.fsPath(),
            homeDir.resolve('.agents/skills').path.fsPath()
        ];
    }
    async processSkillDirectoryWithParentWatching(directoryPath, skills, disposables, watchedDirectories, parentWatchers, qualifier) {
        const dirURI = core_1.URI.fromFilePath(directoryPath);
        try {
            const dirExists = await this.fileService.exists(dirURI);
            if (dirExists) {
                await this.processExistingSkillDirectory(dirURI, skills, disposables, watchedDirectories, qualifier);
            }
            else {
                const parentPath = dirURI.parent.path.fsPath();
                const parentURI = core_1.URI.fromFilePath(parentPath);
                const parentExists = await this.fileService.exists(parentURI);
                if (parentExists) {
                    const parentUriString = parentURI.toString();
                    disposables.push(this.fileService.watch(parentURI, { recursive: false, excludes: [] }));
                    parentWatchers.set(parentUriString, directoryPath);
                    this.logger.debug(`Watching parent directory '${parentPath}' for skills folder creation`);
                }
                else {
                    this.logger.debug(`Cannot watch skills directory '${directoryPath}': parent directory does not exist`);
                }
            }
        }
        catch (error) {
            this.logger.error(`Error processing directory '${directoryPath}': ${error}`);
        }
    }
    async processConfiguredSkillDirectory(directoryPath, skills, disposables, watchedDirectories, qualifier) {
        const dirURI = core_1.URI.fromFilePath(directoryPath);
        try {
            const dirExists = await this.fileService.exists(dirURI);
            if (!dirExists) {
                this.logger.warn(`Configured skill directory '${directoryPath}' does not exist`);
                return;
            }
            await this.processExistingSkillDirectory(dirURI, skills, disposables, watchedDirectories, qualifier);
        }
        catch (error) {
            this.logger.error(`Error processing configured directory '${directoryPath}': ${error}`);
        }
    }
    async processExistingSkillDirectory(dirURI, skills, disposables, watchedDirectories, qualifier) {
        const stat = await this.fileService.resolve(dirURI);
        if (!stat.children) {
            return;
        }
        for (const child of stat.children) {
            if (child.isDirectory) {
                const directoryName = child.name;
                await this.loadSkillFromDirectory(child.resource, directoryName, skills, qualifier);
            }
        }
        this.setupDirectoryWatcher(dirURI, disposables, watchedDirectories);
    }
    async loadSkillFromDirectory(directoryUri, directoryName, skills, qualifier) {
        const skillFileUri = directoryUri.resolve(skill_1.SKILL_FILE_NAME);
        const fileExists = await this.fileService.exists(skillFileUri);
        if (!fileExists) {
            return;
        }
        try {
            const fileContent = await this.fileService.read(skillFileUri);
            const parsed = (0, skill_1.parseSkillFile)(fileContent.value);
            if (!parsed.metadata) {
                this.logger.warn(`Skill in '${directoryName}': SKILL.md file has no valid YAML frontmatter`);
                return;
            }
            if (!skill_1.SkillDescription.is(parsed.metadata)) {
                this.logger.warn(`Skill in '${directoryName}': Invalid skill description - missing required fields (name, description)`);
                return;
            }
            const validationErrors = (0, skill_1.validateSkillDescription)(parsed.metadata, directoryName);
            if (validationErrors.length > 0) {
                this.logger.warn(`Skill in '${directoryName}': ${validationErrors.join('; ')}`);
                return;
            }
            const qualifiedName = skill_1.Skill.qualifyName(parsed.metadata.name, qualifier);
            if (skills.has(qualifiedName)) {
                this.logger.warn(`Skill '${qualifiedName}': Duplicate skill found in '${directoryName}', using first discovered instance`);
                return;
            }
            const skill = {
                ...parsed.metadata,
                location: skillFileUri.path.fsPath(),
                qualifiedName
            };
            skills.set(qualifiedName, skill);
        }
        catch (error) {
            this.logger.error(`Failed to load skill from '${directoryName}': ${error}`);
        }
    }
    setupDirectoryWatcher(dirURI, disposables, watchedDirectories) {
        disposables.push(this.fileService.watch(dirURI, { recursive: true, excludes: [] }));
        watchedDirectories.add(dirURI.toString());
    }
};
exports.DefaultSkillService = DefaultSkillService;
tslib_1.__decorate([
    (0, inversify_1.inject)(ai_core_preferences_1.AICorePreferences),
    tslib_1.__metadata("design:type", Object)
], DefaultSkillService.prototype, "preferences", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(file_service_1.FileService),
    tslib_1.__metadata("design:type", file_service_1.FileService)
], DefaultSkillService.prototype, "fileService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('ai-core:DefaultSkillService'),
    tslib_1.__metadata("design:type", Object)
], DefaultSkillService.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(env_variables_1.EnvVariablesServer),
    tslib_1.__metadata("design:type", Object)
], DefaultSkillService.prototype, "envVariablesServer", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.WorkspaceService),
    tslib_1.__metadata("design:type", browser_1.WorkspaceService)
], DefaultSkillService.prototype, "workspaceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ContributionProvider),
    (0, inversify_1.named)(exports.SkillDirectoryContribution),
    tslib_1.__metadata("design:type", Object)
], DefaultSkillService.prototype, "skillDirectoryContributions", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], DefaultSkillService.prototype, "init", null);
exports.DefaultSkillService = DefaultSkillService = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], DefaultSkillService);
//# sourceMappingURL=skill-service.js.map