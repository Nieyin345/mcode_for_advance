/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { mapFilter } from './arrays.js';
export class ValidatorBase {
    validateOrThrow(content) {
        const result = this.validate(content);
        if (result.error) {
            throw new Error(result.error.message);
        }
        return result.content;
    }
}
class TypeofValidator extends ValidatorBase {
    constructor(type) {
        super();
        this.type = type;
    }
    validate(content) {
        if (typeof content !== this.type) {
            return { content: undefined, error: { message: `Expected ${this.type}, but got ${typeof content}` } };
        }
        return { content: content, error: undefined };
    }
    getJSONSchema() {
        return { type: this.type };
    }
}
const vStringValidator = new TypeofValidator('string');
export function vString() { return vStringValidator; }
const vNumberValidator = new TypeofValidator('number');
export function vNumber() { return vNumberValidator; }
const vBooleanValidator = new TypeofValidator('boolean');
export function vBoolean() { return vBooleanValidator; }
const vObjAnyValidator = new TypeofValidator('object');
export function vObjAny() { return vObjAnyValidator; }
class UncheckedValidator extends ValidatorBase {
    validate(content) {
        return { content: content, error: undefined };
    }
    getJSONSchema() {
        return {};
    }
}
export function vUnchecked() {
    return new UncheckedValidator();
}
class UndefinedValidator extends ValidatorBase {
    validate(content) {
        if (content !== undefined) {
            return { content: undefined, error: { message: `Expected undefined, but got ${typeof content}` } };
        }
        return { content: undefined, error: undefined };
    }
    getJSONSchema() {
        return {};
    }
}
export function vUndefined() {
    return new UndefinedValidator();
}
export function vUnknown() {
    return vUnchecked();
}
export class Optional {
    constructor(validator) {
        this.validator = validator;
    }
}
export function vOptionalProp(validator) {
    return new Optional(validator);
}
class ObjValidator extends ValidatorBase {
    constructor(properties) {
        super();
        this.properties = properties;
    }
    validate(content) {
        if (typeof content !== 'object' || content === null) {
            return { content: undefined, error: { message: 'Expected object' } };
        }
        // eslint-disable-next-line local/code-no-dangerous-type-assertions
        const result = {};
        for (const key in this.properties) {
            const prop = this.properties[key];
            // eslint-disable-next-line local/code-no-any-casts, @typescript-eslint/no-explicit-any
            const fieldValue = content[key];
            const isOptional = prop instanceof Optional;
            const validator = isOptional ? prop.validator : prop;
            if (isOptional && fieldValue === undefined) {
                // Optional field not provided, skip validation
                continue;
            }
            const { content: value, error } = validator.validate(fieldValue);
            if (error) {
                return { content: undefined, error: { message: `Error in property '${key}': ${error.message}` } };
            }
            // eslint-disable-next-line local/code-no-any-casts, @typescript-eslint/no-explicit-any
            result[key] = value;
        }
        return { content: result, error: undefined };
    }
    getJSONSchema() {
        const requiredFields = [];
        const schemaProperties = {};
        for (const [key, prop] of Object.entries(this.properties)) {
            const isOptional = prop instanceof Optional;
            const validator = isOptional ? prop.validator : prop;
            schemaProperties[key] = validator.getJSONSchema();
            if (!isOptional) {
                requiredFields.push(key);
            }
        }
        const schema = {
            type: 'object',
            properties: schemaProperties,
            ...(requiredFields.length > 0 ? { required: requiredFields } : {})
        };
        return schema;
    }
}
export function vObj(properties) {
    return new ObjValidator(properties);
}
class ArrayValidator extends ValidatorBase {
    constructor(validator) {
        super();
        this.validator = validator;
    }
    validate(content) {
        if (!Array.isArray(content)) {
            return { content: undefined, error: { message: 'Expected array' } };
        }
        const result = [];
        for (let i = 0; i < content.length; i++) {
            const { content: value, error } = this.validator.validate(content[i]);
            if (error) {
                return { content: undefined, error: { message: `Error in element ${i}: ${error.message}` } };
            }
            result.push(value);
        }
        return { content: result, error: undefined };
    }
    getJSONSchema() {
        return {
            type: 'array',
            items: this.validator.getJSONSchema(),
        };
    }
}
export function vArray(validator) {
    return new ArrayValidator(validator);
}
class TupleValidator extends ValidatorBase {
    constructor(validators) {
        super();
        this.validators = validators;
    }
    validate(content) {
        if (!Array.isArray(content)) {
            return { content: undefined, error: { message: 'Expected array' } };
        }
        if (content.length !== this.validators.length) {
            return { content: undefined, error: { message: `Expected tuple of length ${this.validators.length}, but got ${content.length}` } };
        }
        const result = [];
        for (let i = 0; i < this.validators.length; i++) {
            const validator = this.validators[i];
            const { content: value, error } = validator.validate(content[i]);
            if (error) {
                return { content: undefined, error: { message: `Error in element ${i}: ${error.message}` } };
            }
            result.push(value);
        }
        return { content: result, error: undefined };
    }
    getJSONSchema() {
        return {
            type: 'array',
            items: this.validators.map(validator => validator.getJSONSchema()),
        };
    }
}
export function vTuple(...validators) {
    return new TupleValidator(validators);
}
class UnionValidator extends ValidatorBase {
    constructor(validators) {
        super();
        this.validators = validators;
    }
    validate(content) {
        let lastError;
        for (const validator of this.validators) {
            const { content: value, error } = validator.validate(content);
            if (!error) {
                // eslint-disable-next-line local/code-no-any-casts, @typescript-eslint/no-explicit-any
                return { content: value, error: undefined };
            }
            lastError = error;
        }
        return { content: undefined, error: lastError };
    }
    getJSONSchema() {
        return {
            oneOf: mapFilter(this.validators, validator => {
                if (validator instanceof UndefinedValidator) {
                    return undefined;
                }
                return validator.getJSONSchema();
            }),
        };
    }
}
export function vUnion(...validators) {
    return new UnionValidator(validators);
}
class EnumValidator extends ValidatorBase {
    constructor(values) {
        super();
        this.values = values;
    }
    validate(content) {
        if (this.values.indexOf(content) === -1) {
            return { content: undefined, error: { message: `Expected one of: ${this.values.join(', ')}` } };
        }
        return { content: content, error: undefined };
    }
    getJSONSchema() {
        return {
            enum: this.values,
        };
    }
}
export function vEnum(...values) {
    return new EnumValidator(values);
}
class LiteralValidator extends ValidatorBase {
    constructor(value) {
        super();
        this.value = value;
    }
    validate(content) {
        if (content !== this.value) {
            return { content: undefined, error: { message: `Expected: ${this.value}` } };
        }
        return { content: content, error: undefined };
    }
    getJSONSchema() {
        return {
            const: this.value,
        };
    }
}
export function vLiteral(value) {
    return new LiteralValidator(value);
}
class LazyValidator extends ValidatorBase {
    constructor(fn) {
        super();
        this.fn = fn;
    }
    validate(content) {
        return this.fn().validate(content);
    }
    getJSONSchema() {
        return this.fn().getJSONSchema();
    }
}
export function vLazy(fn) {
    return new LazyValidator(fn);
}
class UseRefSchemaValidator extends ValidatorBase {
    constructor(_ref, _validator) {
        super();
        this._ref = _ref;
        this._validator = _validator;
    }
    validate(content) {
        return this._validator.validate(content);
    }
    getJSONSchema() {
        return { $ref: this._ref };
    }
}
export function vWithJsonSchemaRef(ref, validator) {
    return new UseRefSchemaValidator(ref, validator);
}
//# sourceMappingURL=validation.js.map