"use strict";
// *****************************************************************************
// Copyright (C) 2020 Ericsson and others.
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
exports.PreferenceTreeGenerator = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const browser_1 = require("@theia/core/lib/browser");
const core_1 = require("@theia/core");
const debounce = require("@theia/core/shared/lodash.debounce");
const preference_types_1 = require("./preference-types");
const preference_layout_1 = require("./preference-layout");
const preference_tree_label_provider_1 = require("./preference-tree-label-provider");
let PreferenceTreeGenerator = class PreferenceTreeGenerator {
    constructor() {
        this._idCache = new Map();
        this.onSchemaChangedEmitter = new core_1.Emitter();
        this.onSchemaChanged = this.onSchemaChangedEmitter.event;
        this.defaultTopLevelCategory = 'extensions';
        this.handleChangedSchema = debounce(this.doHandleChangedSchema, 200);
    }
    get root() {
        return this._root ?? this.generateTree();
    }
    init() {
        this.doInit();
    }
    async doInit() {
        this.schemaProvider.onDidChangeSchema(() => this.handleChangedSchema());
        this.handleChangedSchema();
    }
    generateTree() {
        this._idCache.clear();
        const properties = this.schemaProvider.getSchemaProperties();
        const groups = new Map();
        const root = this.createRootNode();
        const commonlyUsedLayout = this.layoutProvider.getCommonlyUsedLayout();
        const commonlyUsed = this.getOrCreatePreferencesGroup({
            id: commonlyUsedLayout.id,
            group: commonlyUsedLayout.id,
            root,
            groups,
            label: commonlyUsedLayout.label
        });
        for (const layout of this.layoutProvider.getLayout()) {
            this.getOrCreatePreferencesGroup({
                id: layout.id,
                group: layout.id,
                root,
                groups,
                label: layout.label
            });
        }
        for (const preference of commonlyUsedLayout.settings ?? []) {
            if (properties.has(preference)) {
                this.createLeafNode(preference, commonlyUsed, properties.get(preference));
            }
        }
        for (const [propertyName, property] of properties.entries()) {
            if (!property.hidden && !property.deprecationMessage && !this.preferenceConfigs.isSectionName(propertyName) && !core_1.OVERRIDE_PROPERTY_PATTERN.test(propertyName)) {
                if (property.owner) {
                    this.createPluginLeafNode(propertyName, property, root, groups);
                }
                else {
                    this.createBuiltinLeafNode(propertyName, property, root, groups);
                }
            }
        }
        for (const group of groups.values()) {
            if (group.id !== `${preference_layout_1.COMMONLY_USED_SECTION_PREFIX}@${preference_layout_1.COMMONLY_USED_SECTION_PREFIX}`) {
                group.children.sort((a, b) => {
                    const aIsComposite = browser_1.CompositeTreeNode.is(a);
                    const bIsComposite = browser_1.CompositeTreeNode.is(b);
                    if (aIsComposite && !bIsComposite) {
                        return 1;
                    }
                    if (bIsComposite && !aIsComposite) {
                        return -1;
                    }
                    return a.id.localeCompare(b.id);
                });
            }
        }
        this._root = root;
        return root;
    }
    ;
    createBuiltinLeafNode(name, property, root, groups) {
        const { immediateParent, topLevelParent } = this.getParents(name, root, groups);
        this.createLeafNode(name, immediateParent || topLevelParent, property);
    }
    createPluginLeafNode(name, property, root, groups) {
        if (!property.owner) {
            return;
        }
        const groupID = this.defaultTopLevelCategory;
        const subgroupName = property.owner;
        const subsubgroupName = property.group;
        const hasGroup = Boolean(subsubgroupName);
        const toplevelParent = this.getOrCreatePreferencesGroup({
            id: groupID,
            group: groupID,
            root,
            groups
        });
        const subgroupID = [groupID, subgroupName].join('.');
        const subgroupParent = this.getOrCreatePreferencesGroup({
            id: subgroupID,
            group: groupID,
            root: toplevelParent,
            groups,
            expanded: hasGroup,
            label: subgroupName
        });
        const subsubgroupID = [groupID, subgroupName, subsubgroupName].join('.');
        const subsubgroupParent = hasGroup ? this.getOrCreatePreferencesGroup({
            id: subsubgroupID,
            group: subgroupID,
            root: subgroupParent,
            groups,
            depth: 2,
            label: subsubgroupName
        }) : undefined;
        this.createLeafNode(name, subsubgroupParent || subgroupParent, property);
    }
    getNodeId(preferenceId) {
        return this._idCache.get(preferenceId) ?? '';
    }
    getParents(name, root, groups) {
        const layoutItem = this.layoutProvider.getLayoutForPreference(name);
        const labels = (layoutItem?.id ?? name).split('.');
        const groupID = this.getGroupName(labels);
        const subgroupName = groupID !== labels[0]
            ? labels[0]
            // If a layout item is present, any additional segments are sections
            // If not, then the name describes a leaf node and only non-final segments are sections.
            : layoutItem || labels.length > 2
                ? labels.at(1)
                : undefined;
        const topLevelParent = this.getOrCreatePreferencesGroup({
            id: groupID,
            group: groupID,
            root,
            groups,
            label: this.generateName(groupID)
        });
        const immediateParent = subgroupName ? this.getOrCreatePreferencesGroup({
            id: [groupID, subgroupName].join('.'),
            group: groupID,
            root: topLevelParent,
            groups,
            label: layoutItem?.label ?? this.generateName(subgroupName)
        }) : undefined;
        return { immediateParent, topLevelParent };
    }
    getGroupName(labels) {
        const defaultGroup = labels[0];
        if (this.layoutProvider.hasCategory(defaultGroup)) {
            return defaultGroup;
        }
        return this.defaultTopLevelCategory;
    }
    getSubgroupName(labels, computedGroupName) {
        if (computedGroupName !== labels[0]) {
            return labels[0];
        }
        else if (labels.length > 1) {
            return labels[1];
        }
        else {
            return undefined;
        }
    }
    generateName(id) {
        return this.labelProvider.formatString(id);
    }
    doHandleChangedSchema() {
        const newTree = this.generateTree();
        this.onSchemaChangedEmitter.fire(newTree);
    }
    createRootNode() {
        return {
            id: 'root-node-id',
            name: '',
            parent: undefined,
            visible: true,
            children: []
        };
    }
    createLeafNode(property, preferencesGroup, data) {
        const { group } = preference_types_1.Preference.TreeNode.getGroupAndIdFromNodeId(preferencesGroup.id);
        const newNode = {
            id: `${group}@${property}`,
            preferenceId: property,
            parent: preferencesGroup,
            preference: { data },
            depth: preference_types_1.Preference.TreeNode.isTopLevel(preferencesGroup) ? 1 : 2
        };
        this._idCache.set(property, newNode.id);
        browser_1.CompositeTreeNode.addChild(preferencesGroup, newNode);
        return newNode;
    }
    createPreferencesGroup(options) {
        const newNode = {
            id: `${options.group}@${options.id}`,
            visible: true,
            parent: options.root,
            children: [],
            expanded: false,
            selected: false,
            depth: 0,
            label: options.label
        };
        const isTopLevel = preference_types_1.Preference.TreeNode.isTopLevel(newNode);
        if (!(options.expanded ?? isTopLevel)) {
            delete newNode.expanded;
        }
        newNode.depth = options.depth ?? (isTopLevel ? 0 : 1);
        browser_1.CompositeTreeNode.addChild(options.root, newNode);
        return newNode;
    }
    getOrCreatePreferencesGroup(options) {
        const existingGroup = options.groups.get(options.id);
        if (existingGroup) {
            return existingGroup;
        }
        const newNode = this.createPreferencesGroup(options);
        options.groups.set(options.id, newNode);
        return newNode;
    }
    ;
};
exports.PreferenceTreeGenerator = PreferenceTreeGenerator;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.PreferenceSchemaService),
    tslib_1.__metadata("design:type", Object)
], PreferenceTreeGenerator.prototype, "schemaProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.PreferenceConfigurations),
    tslib_1.__metadata("design:type", core_1.PreferenceConfigurations)
], PreferenceTreeGenerator.prototype, "preferenceConfigs", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(preference_layout_1.PreferenceLayoutProvider),
    tslib_1.__metadata("design:type", preference_layout_1.PreferenceLayoutProvider)
], PreferenceTreeGenerator.prototype, "layoutProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(preference_tree_label_provider_1.PreferenceTreeLabelProvider),
    tslib_1.__metadata("design:type", preference_tree_label_provider_1.PreferenceTreeLabelProvider)
], PreferenceTreeGenerator.prototype, "labelProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], PreferenceTreeGenerator.prototype, "init", null);
exports.PreferenceTreeGenerator = PreferenceTreeGenerator = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], PreferenceTreeGenerator);
//# sourceMappingURL=preference-tree-generator.js.map