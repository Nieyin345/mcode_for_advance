"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource GmbH and others.
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
exports.laneColor = laneColor;
exports.getChangeStatus = getChangeStatus;
exports.getFileName = getFileName;
exports.getFilePath = getFilePath;
exports.getRepoRelativePath = getRepoRelativePath;
exports.buildChangeTreeRows = buildChangeTreeRows;
exports.getRefColorIndex = getRefColorIndex;
exports.filterRefsForBadges = filterRefsForBadges;
exports.getRefBadgePresentation = getRefBadgePresentation;
exports.getRefBadgeClass = getRefBadgeClass;
exports.isTagRef = isTagRef;
exports.isRemoteRef = isRemoteRef;
exports.getLocalNameFromRemote = getLocalNameFromRemote;
exports.deduplicateRefs = deduplicateRefs;
/**
 * Returns the CSS color variable for the given color index.
 * Uses Theia's `--theia-scmGraph-*` variables, mirroring the VS Code
 * scm graph color scheme:
 *   0 (current ref)  → historyItemRefColor
 *   1 (remote ref)   → historyItemRemoteRefColor
 *   2 (base ref)     → historyItemBaseRefColor
 *   3–7 (default rotation) → foreground1–5
 */
function laneColor(index) {
    switch (index % 8) {
        case 0: return 'var(--theia-scmGraph-historyItemRefColor)';
        case 1: return 'var(--theia-scmGraph-historyItemRemoteRefColor)';
        case 2: return 'var(--theia-scmGraph-historyItemBaseRefColor)';
        case 3: return 'var(--theia-scmGraph-foreground1)';
        case 4: return 'var(--theia-scmGraph-foreground2)';
        case 5: return 'var(--theia-scmGraph-foreground3)';
        case 6: return 'var(--theia-scmGraph-foreground4)';
        default: return 'var(--theia-scmGraph-foreground5)';
    }
}
function getChangeStatus(change) {
    if (!change.originalUri) {
        return 'A';
    }
    if (!change.modifiedUri) {
        return 'D';
    }
    if (change.renameUri) {
        return 'R';
    }
    return 'M';
}
function getFileName(uri) {
    const parts = uri.split('/');
    return parts[parts.length - 1] || uri;
}
function getFilePath(uri) {
    try {
        const u = new URL(uri);
        return u.pathname;
    }
    catch {
        return uri;
    }
}
/**
 * Returns the repo-relative path of the given URI, stripping the rootUri prefix.
 * Falls back to the full path if rootUri is unavailable or doesn't match.
 */
function getRepoRelativePath(uri, rootUri) {
    const fullPath = getFilePath(uri);
    if (!rootUri) {
        return fullPath;
    }
    const rootPath = getFilePath(rootUri);
    // Normalize: ensure rootPath ends with '/'
    const rootPrefix = rootPath.endsWith('/') ? rootPath : rootPath + '/';
    if (fullPath.startsWith(rootPrefix)) {
        return fullPath.slice(rootPrefix.length);
    }
    return fullPath;
}
/**
 * Arranges history item changes into the rows of a file tree: folders before
 * files, each sorted by name, with single-child folder chains compacted into
 * one row (`src/browser`) the way VS Code's SCM tree renders them. Folders
 * listed in `collapsedFolders` (by their full path) hide their descendants.
 */
function buildChangeTreeRows(changes, rootUri, collapsedFolders) {
    const root = { folders: new Map(), files: [] };
    changes.forEach((change, index) => {
        const relativePath = getRepoRelativePath(change.modifiedUri ?? change.originalUri ?? change.uri, rootUri);
        const segments = relativePath.split('/').filter(segment => segment.length > 0);
        const name = segments.pop() ?? relativePath;
        let folder = root;
        for (const segment of segments) {
            let child = folder.folders.get(segment);
            if (!child) {
                child = { folders: new Map(), files: [] };
                folder.folders.set(segment, child);
            }
            folder = child;
        }
        folder.files.push({ change, index, name });
    });
    const rows = [];
    collectChangeTreeRows(root, '', '', 0, collapsedFolders, rows);
    return rows;
}
function collectChangeTreeRows(folder, path, label, depth, collapsedFolders, rows) {
    for (const name of [...folder.folders.keys()].sort(compareNames)) {
        let child = folder.folders.get(name);
        let childPath = path ? `${path}/${name}` : name;
        let childLabel = label ? `${label}/${name}` : name;
        // Compact a chain of folders that each hold nothing but one folder.
        while (child.files.length === 0 && child.folders.size === 1) {
            const [onlyName, onlyChild] = [...child.folders][0];
            child = onlyChild;
            childPath = `${childPath}/${onlyName}`;
            childLabel = `${childLabel}/${onlyName}`;
        }
        rows.push({ type: 'folder', path: childPath, label: childLabel, depth });
        if (!collapsedFolders.has(childPath)) {
            collectChangeTreeRows(child, childPath, '', depth + 1, collapsedFolders, rows);
        }
    }
    for (const file of [...folder.files].sort((left, right) => compareNames(left.name, right.name))) {
        rows.push({
            type: 'file',
            path: path ? `${path}/${file.name}` : file.name,
            depth,
            change: file.change,
            index: file.index
        });
    }
}
function compareNames(left, right) {
    return left.localeCompare(right);
}
/**
 * Returns the ref-based color index of the given ref (0 = current ref,
 * 1 = remote ref, 2 = base ref), or `undefined` when the ref is none of
 * the provider's current history item refs. Mirrors VS Code's scm graph
 * color map.
 */
function getRefColorIndex(ref, provider) {
    if (!provider) {
        return undefined;
    }
    if (ref.id === provider.currentHistoryItemRef?.id) {
        return 0;
    }
    if (ref.id === provider.currentHistoryItemRemoteRef?.id) {
        return 1;
    }
    if (ref.id === provider.currentHistoryItemBaseRef?.id) {
        return 2;
    }
    return undefined;
}
/**
 * Filters which refs get badges in the graph, following VS Code's
 * `scm.graph.badges` setting: `'all'` shows every ref, `'filter'` shows only
 * the refs used as the graph's filter — the explicitly picked ref ids, or,
 * without an explicit filter (auto mode), the current, remote, and base refs.
 * Without provider information all refs are kept.
 */
function filterRefsForBadges(refs, provider, badges, filter) {
    if (badges === 'all') {
        return refs;
    }
    if (filter) {
        return refs.filter(ref => filter.includes(ref.id));
    }
    if (!provider) {
        return refs;
    }
    return refs.filter(ref => getRefColorIndex(ref, provider) !== undefined);
}
/**
 * Resolves how a ref badge is presented: the provider-supplied codicon icon
 * when available (VS Code renders `ref.icon` unconditionally), otherwise a
 * category fallback with the `target` icon marking the current ref; plus the
 * ref-based color index.
 */
function getRefBadgePresentation(ref, provider) {
    const colorIndex = getRefColorIndex(ref, provider);
    let iconClass;
    if (ref.icon && ref.icon.startsWith('codicon ')) {
        iconClass = ref.icon.substring('codicon '.length);
    }
    else if (isTagRef(ref)) {
        iconClass = 'codicon-tag';
    }
    else if (isRemoteRef(ref)) {
        iconClass = 'codicon-cloud';
    }
    else {
        iconClass = colorIndex === 0 ? 'codicon-target' : 'codicon-git-branch';
    }
    return { iconClass, colorIndex };
}
function getRefBadgeClass(ref) {
    const cat = (ref.category ?? '').toLowerCase();
    if (cat === 'heads' || cat === 'head' || ref.id.startsWith('refs/heads/')) {
        return 'head';
    }
    if (cat === 'remotes' || cat === 'remote' || ref.id.startsWith('refs/remotes/')) {
        return 'remote';
    }
    if (cat === 'tags' || cat === 'tag' || ref.id.startsWith('refs/tags/')) {
        return 'tag';
    }
    if (cat === 'base') {
        return 'base';
    }
    return 'head';
}
function isTagRef(ref) {
    const cat = (ref.category ?? '').toLowerCase();
    if (cat === 'tags' || cat === 'tag') {
        return true;
    }
    // Fall back to checking the ref id prefix (e.g. 'refs/tags/v1.0')
    return ref.id.startsWith('refs/tags/');
}
function isRemoteRef(ref) {
    const cat = (ref.category ?? '').toLowerCase();
    if (cat === 'remotes' || cat === 'remote') {
        return true;
    }
    // Fall back to checking the ref id prefix (e.g. 'refs/remotes/origin/main')
    return ref.id.startsWith('refs/remotes/');
}
/**
 * Extracts the local branch name from a remote ref name like "origin/master" → "master".
 * Falls back to the full name if no slash is found.
 */
function getLocalNameFromRemote(remoteName) {
    const slashIdx = remoteName.indexOf('/');
    return slashIdx >= 0 ? remoteName.slice(slashIdx + 1) : remoteName;
}
/**
 * Deduplicates refs: when a local branch (e.g. "master") and a remote branch
 * (e.g. "origin/master") both appear, collapse them into one entry with `hasBoth=true`.
 * Tags and other ref types are passed through unchanged.
 */
function deduplicateRefs(refs) {
    const localNames = new Set();
    for (const ref of refs) {
        if (!isRemoteRef(ref) && !isTagRef(ref)) {
            localNames.add(ref.name.toLowerCase());
        }
    }
    const result = [];
    const suppressedRemotes = new Set();
    // First pass: identify remote refs that have a matching local branch
    for (const ref of refs) {
        if (isRemoteRef(ref)) {
            const localName = getLocalNameFromRemote(ref.name).toLowerCase();
            if (localNames.has(localName)) {
                suppressedRemotes.add(ref.id);
            }
        }
    }
    // Second pass: emit all refs except suppressed remote ones;
    // mark local branches that have a matching remote with hasBoth=true
    for (const ref of refs) {
        if (suppressedRemotes.has(ref.id)) {
            continue;
        }
        const hasBoth = !isRemoteRef(ref) && !isTagRef(ref)
            ? refs.some(r => isRemoteRef(r) && getLocalNameFromRemote(r.name).toLowerCase() === ref.name.toLowerCase())
            : false;
        result.push({ ref, hasBoth });
    }
    return result;
}
//# sourceMappingURL=scm-history-graph-helpers.js.map