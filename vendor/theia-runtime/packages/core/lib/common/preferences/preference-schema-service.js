"use strict";
// *****************************************************************************
// Copyright (C) 2025 STMicroelectronics and others.
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
exports.PreferenceSchemaServiceImpl = exports.OVERRIDE_PROPERTY = exports.NO_OVERRIDE = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("inversify");
const disposable_1 = require("../disposable");
const event_1 = require("../event");
const preference_schema_1 = require("./preference-schema");
const preference_scope_1 = require("./preference-scope");
const preference_provider_1 = require("./preference-provider");
const contribution_provider_1 = require("../contribution-provider");
const promise_util_1 = require("../promise-util");
const logger_1 = require("../logger");
exports.NO_OVERRIDE = {};
exports.OVERRIDE_PROPERTY = '\\[(.*)\\]$';
let PreferenceSchemaServiceImpl = class PreferenceSchemaServiceImpl {
    constructor() {
        // Storage structures
        this.schemas = new Set();
        this.properties = new Map();
        /**
         * This map stores default overrides. The primary map key is the base preference name.
         * The preference name maps to a second map keyed by the override identifier or a special object value `NO_OVERRIDE',
         * representing default overrides for the base property. The value in this second map is an array
         * of entries in reverse order of their insertion. This is necessary becuaus multiple clients might register
         * overrides for the same preference key/override combination. The elements in this array consist of a unique, generated
         * identifier and the actual override value. This allows us to always return the last registerd override even
         * when overrides are later removed.
         */
        this.defaultOverrides = new Map();
        this._overrideIdentifiers = new Set();
        this.jsonSchemas = [];
        this._ready = new promise_util_1.Deferred();
        this.nextSchemaTitle = 1;
        this.nextOverrideValueId = 1;
        // Event emitters
        this.defaultValueChangedEmitter = new event_1.Emitter();
        this.schemaChangedEmitter = new event_1.Emitter();
        // Public events
        this.onDidChangeDefaultValue = this.defaultValueChangedEmitter.event;
        this.onDidChangeSchema = this.schemaChangedEmitter.event;
        this.pendingDefaultRegistrationWarnings = new Set();
    }
    get ready() {
        return this._ready.promise;
    }
    get overrideIdentifiers() {
        return this._overrideIdentifiers;
    }
    getSchemaProperties() {
        return this.properties;
    }
    init() {
        for (const scope of this.validScopes) {
            this.jsonSchemas[scope] = {
                type: 'object',
                properties: {},
                patternProperties: {},
                additionalProperties: false
            };
        }
        const promises = [];
        this.preferenceContributions.getContributions().forEach(contrib => {
            if (contrib.schema) {
                this.addSchema(contrib.schema);
            }
            if (contrib.initSchema) {
                promises.push(contrib.initSchema(this));
            }
        });
        Promise.all(promises).then(() => {
            this._ready.resolve();
            this.logDefaultRegistrationWarnings();
        });
    }
    dispose() {
        this.defaultValueChangedEmitter.dispose();
        this.schemaChangedEmitter.dispose();
    }
    registerOverrideIdentifier(overrideIdentifier) {
        if (!this._overrideIdentifiers.has(overrideIdentifier)) {
            this.addOverrideToJsonSchema(overrideIdentifier);
            this._overrideIdentifiers.add(overrideIdentifier);
            this.schemaChangedEmitter.fire();
            return disposable_1.Disposable.create(() => {
                if (this._overrideIdentifiers.delete(overrideIdentifier)) {
                    this.schemaChangedEmitter.fire();
                }
            });
        }
        return disposable_1.Disposable.NULL;
    }
    addSchema(schema) {
        this.schemas.add(schema);
        for (const [key, property] of Object.entries(schema.properties)) {
            if (this.properties.has(key)) {
                this.logger.warn(`Property with id '${key}' already exists`);
                continue;
            }
            this.pendingDefaultRegistrationWarnings?.delete(key);
            if (property.scope === undefined) {
                property.scope = schema.scope;
            }
            if (property.overridable === undefined) {
                property.overridable = schema.defaultOverridable;
            }
            this.properties.set(key, property);
            this.setJSONSchemasProperty(key, property);
            if (property.default !== undefined) {
                this.defaultValueChangedEmitter.fire(this.changeFor(key, undefined, this.defaultOverrides.get(key), undefined, property.default));
            }
        }
        this.schemaChangedEmitter.fire();
        return disposable_1.Disposable.create(() => {
            if (this.schemas.delete(schema)) {
                for (const [key, property] of Object.entries(schema.properties)) {
                    this.deleteFromJSONSchemas(key, property);
                    this.properties.delete(key);
                    const overrides = this.defaultOverrides.get(key);
                    const baseOverride = overrides?.get(exports.NO_OVERRIDE);
                    if (baseOverride !== undefined) {
                        this.defaultValueChangedEmitter.fire(this.changeFor(key, undefined, overrides, baseOverride, undefined));
                    }
                    else if (property.default !== undefined) {
                        this.defaultValueChangedEmitter.fire(this.changeFor(key, undefined, overrides, property.default, undefined));
                    }
                    if (overrides) {
                        for (const [overrideKey, value] of overrides) {
                            if (typeof overrideKey === 'string') {
                                this.defaultValueChangedEmitter.fire(this.changeFor(key, overrideKey, overrides, value[0][1], undefined));
                            }
                        }
                    }
                }
                this.schemaChangedEmitter.fire();
            }
        });
    }
    isValidInScope(preferenceName, scope) {
        const property = this.properties.get(preferenceName);
        if (!property) {
            return false;
        }
        // A property is valid in a scope if:
        // 1. It is included (undefined or true)
        // 2. Its scope is not defined (valid in all scopes) or its scope includes the given scope
        return (property.included !== false) &&
            (property.scope === undefined || property.scope >= scope);
    }
    getSchemaProperty(key) {
        return this.properties.get(key);
    }
    updateSchemaProperty(key, property) {
        const existing = this.properties.get(key);
        if (existing) {
            // Update the property with new values
            const updatedProperty = { ...existing, ...property };
            this.properties.set(key, updatedProperty);
            const hasNoBaseOverrideValue = this.defaultOverrides.get(key)?.get(exports.NO_OVERRIDE) === undefined;
            if (hasNoBaseOverrideValue && !preference_provider_1.PreferenceUtils.deepEqual(property.default, existing.default)) {
                this.defaultValueChangedEmitter.fire(this.changeFor(key, undefined, this.defaultOverrides.get(key), undefined, property.default));
            }
            this.setJSONSchemasProperty(key, updatedProperty);
            this.schemaChangedEmitter.fire();
        }
        else {
            this.logger.warn(`Trying to update non-existent property ${key}`);
        }
    }
    logDefaultRegistrationWarnings() {
        if (this.pendingDefaultRegistrationWarnings?.size) {
            this.logger.warn('Default overrides registered for these keys, but preferences not registered', Array.from(this.pendingDefaultRegistrationWarnings));
        }
        this.pendingDefaultRegistrationWarnings = undefined;
    }
    logDefaultRegistrationWarning(key) {
        if (this.pendingDefaultRegistrationWarnings) {
            this.pendingDefaultRegistrationWarnings.add(key);
        }
        else {
            this.logger.warn(`Trying to register default override for non-existent preference: ${key}`);
        }
    }
    registerOverride(key, overrideIdentifier, value) {
        const overrideId = overrideIdentifier || exports.NO_OVERRIDE;
        const property = this.properties.get(key);
        if (!property) {
            this.logDefaultRegistrationWarning(key);
        }
        else if (!property.overridable && overrideIdentifier) {
            this.logger.warn(`Trying to register default override for identifier ${overrideIdentifier} for non-overridable preference: ${key}`);
        }
        let overrides = this.defaultOverrides.get(key);
        if (!overrides) {
            overrides = new Map();
            this.defaultOverrides.set(key, overrides);
        }
        const oldValue = this.getDefaultValue(key, overrideIdentifier);
        const overrideValueId = this.nextOverrideValueId;
        let override = overrides.get(overrideId);
        if (!override) {
            override = [];
            overrides.set(overrideId, override);
        }
        override.unshift([overrideValueId, value]);
        // Fire event only if the value actually changed
        if (!preference_provider_1.PreferenceUtils.deepEqual(oldValue, value)) {
            const evt = this.changeFor(key, overrideIdentifier, overrides, oldValue, value);
            this.defaultValueChangedEmitter.fire(evt);
        }
        if (property) {
            this.setJSONSchemasProperty(key, property);
        }
        return disposable_1.Disposable.create(() => {
            this.removeOverride(key, overrideIdentifier, overrideValueId);
        });
    }
    changeFor(key, overrideIdentifier, overrides, oldValue, newValue) {
        const affectedOverrides = [];
        if (!overrideIdentifier) {
            for (const id of this._overrideIdentifiers) {
                if (!overrides?.has(id)) {
                    affectedOverrides.push(id);
                }
            }
        }
        return {
            key,
            overrideIdentifier: overrideIdentifier,
            otherAffectedOverrides: affectedOverrides,
            oldValue,
            newValue
        };
    }
    removeOverride(key, overrideIdentifier, overrideValueId) {
        const overrideId = overrideIdentifier || exports.NO_OVERRIDE;
        const overrides = this.defaultOverrides.get(key);
        if (overrides) {
            const values = overrides.get(overrideId);
            if (values) {
                const index = values.findIndex(v => v[0] === overrideValueId);
                if (index) {
                    const oldValue = this.getDefaultValue(key, overrideIdentifier);
                    values.splice(index, 1);
                    const newValue = this.getDefaultValue(key, overrideIdentifier);
                    if (!preference_provider_1.PreferenceUtils.deepEqual(oldValue, newValue)) {
                        const affectedOverrides = [];
                        if (!overrideIdentifier) {
                            for (const id of this._overrideIdentifiers) {
                                if (!overrides.has(id)) {
                                    affectedOverrides.push(id);
                                }
                            }
                        }
                        this.defaultValueChangedEmitter.fire({
                            key,
                            overrideIdentifier,
                            otherAffectedOverrides: affectedOverrides,
                            oldValue,
                            newValue
                        });
                    }
                }
                if (values.length === 0) {
                    overrides.delete(overrideId);
                }
            }
            if (overrides.size === 0) {
                this.defaultOverrides.delete(key);
            }
        }
    }
    getDefaultValue(key, overrideIdentifier) {
        const overrideId = overrideIdentifier || exports.NO_OVERRIDE;
        const overrides = this.defaultOverrides.get(key);
        if (overrides) {
            const values = overrides.get(overrideId);
            if (values) {
                return values[0][1]; // there will be no empty values arrays in the data structure
            }
        }
        const property = this.properties.get(key);
        return property?.default;
    }
    inspectDefaultValue(key, overrideIdentifier) {
        const overrideId = overrideIdentifier || exports.NO_OVERRIDE;
        const overrides = this.defaultOverrides.get(key);
        if (overrides) {
            const values = overrides.get(overrideId);
            if (values) {
                return values[0][1]; // there will be no empty values arrays in the data structure
            }
        }
        if (!overrideIdentifier) {
            const property = this.properties.get(key);
            return property?.default;
        }
        return undefined;
    }
    getJSONSchema(scope) {
        return this.jsonSchemas[scope];
    }
    setJSONSchemasProperty(key, property) {
        for (const scope of this.validScopes) {
            if (this.isValidInScope(key, scope)) {
                this.setJSONSchemaProperty(this.jsonSchemas[scope], key, property);
            }
        }
    }
    deleteFromJSONSchemas(key, property) {
        for (const scope of this.validScopes) {
            if (this.isValidInScope(key, scope)) {
                const schema = this.jsonSchemas[scope];
                for (const name of Object.keys(schema.properties)) {
                    if (name.match(exports.OVERRIDE_PROPERTY)) {
                        const value = schema.properties[name];
                        delete value.properties[key];
                    }
                    else {
                        delete schema.properties[key];
                    }
                }
            }
        }
    }
    setJSONSchemaProperty(schema, key, property) {
        // Add property to the schema
        const prop = { ...property, default: this.getDefaultValue(key, undefined) };
        schema.properties[key] = prop;
        delete prop['scope'];
        delete prop['overridable'];
        if (property.overridable) {
            for (const overrideIdentifier of this._overrideIdentifiers) {
                const overrideSchema = schema.properties[`[${overrideIdentifier}]`] || {
                    type: 'object',
                    properties: {},
                    patternProperties: {},
                    additionalProperties: false
                };
                schema.properties[`[${overrideIdentifier}]`] = overrideSchema;
                overrideSchema.properties[key] = { ...property, default: this.getDefaultValue(key, overrideIdentifier) };
            }
        }
    }
    addOverrideToJsonSchema(overrideIdentifier) {
        for (const scope of this.validScopes) {
            const schema = this.jsonSchemas[scope];
            const overrideSchema = {
                type: 'object',
                properties: {},
                patternProperties: {},
                additionalProperties: false
            };
            schema.properties[`[${overrideIdentifier}]`] = overrideSchema;
            for (const [key, property] of this.properties.entries()) {
                if (property.overridable && this.isValidInScope(key, scope)) {
                    overrideSchema.properties[key] = { ...property, default: this.getDefaultValue(key, overrideIdentifier) };
                }
            }
        }
    }
    getDefaultValues() {
        const result = {};
        for (const [key, property] of this.properties.entries()) {
            if (this.isValidInScope(key, preference_scope_1.PreferenceScope.Default)) {
                if (property.default !== undefined) {
                    result[key] = property.default;
                }
                const overrides = this.defaultOverrides.get(key);
                if (overrides) {
                    for (const [overrideId, values] of overrides.entries()) {
                        if (overrideId === exports.NO_OVERRIDE) {
                            result[key] = values[0][1];
                        }
                        else {
                            const overrideKey = `[${overrideId}]`;
                            const target = result[overrideKey] || {};
                            target[key] = values[0][1];
                            result[overrideKey] = target;
                        }
                    }
                }
            }
        }
        return result;
    }
};
exports.PreferenceSchemaServiceImpl = PreferenceSchemaServiceImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(preference_scope_1.ValidPreferenceScopes),
    tslib_1.__metadata("design:type", Array)
], PreferenceSchemaServiceImpl.prototype, "validScopes", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(contribution_provider_1.ContributionProvider),
    (0, inversify_1.named)(preference_schema_1.PreferenceContribution),
    tslib_1.__metadata("design:type", Object)
], PreferenceSchemaServiceImpl.prototype, "preferenceContributions", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(logger_1.ILogger),
    (0, inversify_1.named)('core:PreferenceSchemaServiceImpl'),
    tslib_1.__metadata("design:type", Object)
], PreferenceSchemaServiceImpl.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], PreferenceSchemaServiceImpl.prototype, "init", null);
exports.PreferenceSchemaServiceImpl = PreferenceSchemaServiceImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], PreferenceSchemaServiceImpl);
//# sourceMappingURL=preference-schema-service.js.map