"use strict";
var ScmRepositoriesWidget_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScmRepositoriesWidget = exports.SCM_REPOSITORY_MENU = exports.SCM_SOURCE_CONTROL_TITLE_MENU = exports.SCM_SOURCE_CONTROL_CONTEXT_MENU = exports.SCM_SOURCE_CONTROL_MENU = exports.SCM_TITLE_MENU = void 0;
const tslib_1 = require("tslib");
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
// *****************************************************************************
// Copyright (C) 2024 EclipseSource GmbH and others.
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
const inversify_1 = require("@theia/core/shared/inversify");
const React = require("@theia/core/shared/react");
const browser_1 = require("@theia/core/lib/browser");
const label_parser_1 = require("@theia/core/lib/browser/label-parser");
const common_1 = require("@theia/core/lib/common");
const disposable_1 = require("@theia/core/lib/common/disposable");
const nls_1 = require("@theia/core/lib/common/nls");
const path_1 = require("@theia/core/lib/common/path");
const uri_1 = require("@theia/core/lib/common/uri");
const scm_service_1 = require("./scm-service");
const scm_context_key_service_1 = require("./scm-context-key-service");
/** Menu path matching the VS Code 'scm/title' contribution point (git actions: Pull, Push, etc.). */
exports.SCM_TITLE_MENU = ['plugin_scm/title'];
/** Menu path matching the VS Code 'scm/sourceControl' contribution point (inline toolbar actions on repo entries). */
exports.SCM_SOURCE_CONTROL_MENU = ['plugin_scm/sourceControl'];
/**
 * @deprecated The 'scm/sourceControl/context' contribution point does not exist in VS Code.
 * Use {@link SCM_SOURCE_CONTROL_MENU} instead.
 */
exports.SCM_SOURCE_CONTROL_CONTEXT_MENU = ['plugin_scm/sourceControl/context'];
/** Menu path matching the VS Code 'scm/sourceControl/title' contribution point (REPOSITORIES section header toolbar). */
exports.SCM_SOURCE_CONTROL_TITLE_MENU = ['plugin_scm/sourceControl/title'];
/** Menu path matching the VS Code 'scm/repository' contribution point (per-repo \`...\` button). */
exports.SCM_REPOSITORY_MENU = ['plugin_scm/repository'];
let ScmRepositoriesWidget = class ScmRepositoriesWidget extends browser_1.ReactWidget {
    constructor() {
        super(...arguments);
        this.toDisposeOnRepositoriesChange = new disposable_1.DisposableCollection();
        this.collapsedRoots = new Set();
    }
    static { ScmRepositoriesWidget_1 = this; }
    static { this.ID = 'scm-repositories-widget'; }
    init() {
        this.id = ScmRepositoriesWidget_1.ID;
        this.title.label = nls_1.nls.localizeByDefault('Repositories');
        this.title.caption = this.title.label;
        this.toDispose.push(this.toDisposeOnRepositoriesChange);
        this.toDispose.push(this.scmService.onDidAddRepository(() => this.onRepositoriesChanged()));
        this.toDispose.push(this.scmService.onDidRemoveRepository(() => this.onRepositoriesChanged()));
        this.toDispose.push(this.scmService.onDidChangeSelectedRepository(() => this.update()));
        this.onRepositoriesChanged();
    }
    onRepositoriesChanged() {
        // Re-subscribe to each repo's status bar command changes so non-selected
        // repos also trigger a re-render when their branch/status changes.
        this.toDisposeOnRepositoriesChange.dispose();
        for (const repo of this.scmService.repositories) {
            if (repo.provider.onDidChangeStatusBarCommands) {
                this.toDisposeOnRepositoriesChange.push(repo.provider.onDidChangeStatusBarCommands(() => this.update()));
            }
            if (repo.provider.onDidChange) {
                this.toDisposeOnRepositoriesChange.push(repo.provider.onDidChange(() => this.update()));
            }
        }
        // Only programmatically show — never programmatically hide.
        // The user can manually hide the widget via the Views menu.
        // On first launch, `initiallyHidden: true` keeps it hidden until repos >= 2.
        if (this.scmService.repositories.length >= 2) {
            const partOrSelf = this.parent ?? this;
            partOrSelf.setHidden(false);
        }
        this.update();
    }
    groupRepositories() {
        const repos = this.scmService.repositories;
        if (repos.length === 0) {
            return [];
        }
        const repoByRootUri = new Map();
        for (const repo of repos) {
            repoByRootUri.set(repo.provider.rootUri, repo);
        }
        const groups = new Map();
        const childRepos = new Set();
        // First pass: identify repos that have a parent (worktrees/submodules)
        for (const repo of repos) {
            const parentUri = repo.parentRootUri;
            if (parentUri && repoByRootUri.has(parentUri)) {
                childRepos.add(repo);
            }
        }
        // Second pass: create groups for root repos and assign children
        for (const repo of repos) {
            if (childRepos.has(repo)) {
                continue;
            }
            const rootUri = repo.provider.rootUri;
            groups.set(rootUri, {
                root: repo,
                children: [],
                collapsed: this.collapsedRoots.has(rootUri)
            });
        }
        // Third pass: assign children to their parent groups
        for (const repo of repos) {
            const parentUri = repo.parentRootUri;
            if (parentUri && childRepos.has(repo)) {
                const parentGroup = groups.get(parentUri);
                if (parentGroup) {
                    parentGroup.children.push(repo);
                }
            }
        }
        return [...groups.values()];
    }
    getRepoDescriptions() {
        const repos = this.scmService.repositories;
        const descriptions = new Map();
        const byName = new Map();
        for (const repo of repos) {
            const name = this.labelProvider.getName(new uri_1.default(repo.provider.rootUri));
            const list = byName.get(name) ?? [];
            list.push(repo);
            byName.set(name, list);
        }
        for (const group of byName.values()) {
            if (group.length < 2) {
                continue;
            }
            const parentPaths = group.map(r => new uri_1.default(r.provider.rootUri).path.dir);
            const basePath = this.commonParentPath(parentPaths);
            for (let i = 0; i < group.length; i++) {
                const relative = basePath.relative(parentPaths[i]);
                const desc = relative?.toString() || '/';
                descriptions.set(group[i], desc);
            }
        }
        return descriptions;
    }
    commonParentPath(paths) {
        if (paths.length === 0) {
            return new path_1.Path('');
        }
        let common = paths[0];
        for (let i = 1; i < paths.length; i++) {
            while (!common.isEqualOrParent(paths[i])) {
                common = common.dir;
            }
        }
        return common;
    }
    render() {
        const groups = this.groupRepositories();
        const descriptions = this.getRepoDescriptions();
        return ((0, jsx_runtime_1.jsx)("div", { className: 'theia-scm-repositories-container', children: groups.map(group => this.renderGroup(group, descriptions)) }));
    }
    renderGroup(group, descriptions) {
        const { root, children, collapsed } = group;
        const hasChildren = children.length > 0;
        return ((0, jsx_runtime_1.jsxs)(React.Fragment, { children: [this.renderRepository(root, hasChildren, collapsed, false, descriptions), hasChildren && !collapsed && children.map(child => this.renderRepository(child, false, false, true, descriptions))] }, `${root.provider.id}:${root.provider.rootUri}`));
    }
    renderRepository(repo, hasChildren, collapsed, isChild = false, descriptions = new Map()) {
        const isSelected = repo === this.scmService.selectedRepository;
        const rootUri = repo.provider.rootUri;
        const itemKey = `${repo.provider.id}:${rootUri}`;
        const uri = new uri_1.default(rootUri);
        const name = this.labelProvider.getName(uri);
        const description = descriptions.get(repo);
        const statusCommands = repo.provider.statusBarCommands ?? [];
        const repoIcon = this.getRepoIcon(repo, isChild);
        return ((0, jsx_runtime_1.jsxs)("div", { className: `theia-scm-repository-item${isSelected ? ' selected' : ''}${isChild ? ' child' : ''}`, onClick: () => this.selectRepository(repo), onContextMenu: e => { e.preventDefault(); e.stopPropagation(); this.showSourceControlContextMenu(e, repo); }, title: rootUri, children: [hasChildren ? ((0, jsx_runtime_1.jsx)("span", { className: `theia-scm-repository-collapse-toggle ${(0, browser_1.codicon)(collapsed ? 'chevron-right' : 'chevron-down')}`, onClick: e => { e.stopPropagation(); this.toggleCollapse(repo.provider.rootUri); } })) : (isChild && (0, jsx_runtime_1.jsx)("span", { className: 'theia-scm-repository-child-indent' })), (0, jsx_runtime_1.jsx)("span", { className: `theia-scm-repository-icon ${repoIcon}` }), (0, jsx_runtime_1.jsxs)("div", { className: 'theia-scm-repository-label', children: [(0, jsx_runtime_1.jsx)("span", { className: 'theia-scm-repository-name', children: name }), description && (0, jsx_runtime_1.jsx)("span", { className: 'theia-scm-repository-description', children: description })] }), (0, jsx_runtime_1.jsxs)("div", { className: 'theia-scm-repository-actions', children: [statusCommands.length > 0 && ((0, jsx_runtime_1.jsx)("div", { className: 'theia-scm-repository-status-commands', children: statusCommands.map((cmd, i) => this.renderStatusCommand(cmd, i, isSelected)) })), (0, jsx_runtime_1.jsx)("a", { className: `theia-scm-repository-more-button ${(0, browser_1.codicon)('ellipsis')}${isSelected ? ' selected' : ''}`, title: nls_1.nls.localizeByDefault('More Actions...'), onClick: e => { e.stopPropagation(); this.showContextMenu(e, repo); } })] })] }, itemKey));
    }
    renderStatusCommand(cmd, index, isSelected) {
        const parts = this.labelParser.parse(cmd.title);
        const content = parts.map((part, i) => {
            if (label_parser_1.LabelIcon.is(part)) {
                return (0, jsx_runtime_1.jsx)("span", { className: (0, browser_1.codicon)(part.name) }, i);
            }
            return (0, jsx_runtime_1.jsx)("span", { children: part }, i);
        });
        const tooltip = cmd.tooltip ?? this.labelParser.stripIcons(cmd.title);
        return ((0, jsx_runtime_1.jsx)("a", { className: `theia-scm-repository-status-command${isSelected ? ' selected' : ''}`, title: tooltip, onClick: e => {
                e.stopPropagation();
                if (cmd.command) {
                    this.commandService.executeCommand(cmd.command, ...(cmd.arguments ?? []));
                }
            }, children: content }, index));
    }
    toggleCollapse(rootUri) {
        if (this.collapsedRoots.has(rootUri)) {
            this.collapsedRoots.delete(rootUri);
        }
        else {
            this.collapsedRoots.add(rootUri);
        }
        this.update();
    }
    showContextMenu(e, repo) {
        // Select the repo and set the context key so command when-clauses resolve correctly.
        this.scmService.selectedRepository = repo;
        this.scmContextKeys.scmProvider.set(repo.provider.id);
        this.scmContextKeys.scmProviderContext.set(repo.provider.providerContextValue);
        const anchor = e.nativeEvent;
        // Defer one tick so the selectedRepository change propagates through context keys.
        setTimeout(() => {
            this.contextMenuRenderer.render({
                menuPath: exports.SCM_REPOSITORY_MENU,
                anchor,
                args: [repo],
                context: this.node
            });
        }, 0);
    }
    showSourceControlContextMenu(e, repo) {
        this.scmService.selectedRepository = repo;
        this.scmContextKeys.scmProvider.set(repo.provider.id);
        this.scmContextKeys.scmProviderContext.set(repo.provider.providerContextValue);
        const anchor = e.nativeEvent;
        setTimeout(() => {
            this.contextMenuRenderer.render({
                menuPath: exports.SCM_SOURCE_CONTROL_MENU,
                anchor,
                args: [repo],
                context: this.node
            });
        }, 0);
    }
    getRepoIcon(repo, isChild) {
        const ctx = repo.provider.providerContextValue;
        if (ctx === 'worktree') {
            return (0, browser_1.codicon)('worktree');
        }
        if (ctx === 'submodule') {
            return (0, browser_1.codicon)('file-submodule');
        }
        if (isChild) {
            return (0, browser_1.codicon)('repo-forked');
        }
        return (0, browser_1.codicon)('repo');
    }
    selectRepository(repo) {
        this.scmService.selectedRepository = repo;
    }
};
exports.ScmRepositoriesWidget = ScmRepositoriesWidget;
tslib_1.__decorate([
    (0, inversify_1.inject)(scm_service_1.ScmService),
    tslib_1.__metadata("design:type", scm_service_1.ScmService)
], ScmRepositoriesWidget.prototype, "scmService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.LabelProvider),
    tslib_1.__metadata("design:type", browser_1.LabelProvider)
], ScmRepositoriesWidget.prototype, "labelProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(label_parser_1.LabelParser),
    tslib_1.__metadata("design:type", label_parser_1.LabelParser)
], ScmRepositoriesWidget.prototype, "labelParser", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.CommandService),
    tslib_1.__metadata("design:type", Object)
], ScmRepositoriesWidget.prototype, "commandService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.ContextMenuRenderer),
    tslib_1.__metadata("design:type", browser_1.ContextMenuRenderer)
], ScmRepositoriesWidget.prototype, "contextMenuRenderer", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(scm_context_key_service_1.ScmContextKeyService),
    tslib_1.__metadata("design:type", scm_context_key_service_1.ScmContextKeyService)
], ScmRepositoriesWidget.prototype, "scmContextKeys", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], ScmRepositoriesWidget.prototype, "init", null);
exports.ScmRepositoriesWidget = ScmRepositoriesWidget = ScmRepositoriesWidget_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], ScmRepositoriesWidget);
//# sourceMappingURL=scm-repositories-widget.js.map