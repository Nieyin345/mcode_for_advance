"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// *****************************************************************************
// Copyright (C) 2025 EclipseSource GmbH.
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
const chai_1 = require("chai");
const language_model_1 = require("../common/language-model");
describe('isToolRequestParameters', () => {
    it('should return true for valid ToolRequestParameters', () => {
        const validParams = {
            type: 'object',
            properties: {
                param1: {
                    type: 'string'
                },
                param2: {
                    type: 'number'
                }
            },
            required: ['param1']
        };
        (0, chai_1.expect)(language_model_1.ToolRequest.isToolRequestParameters(validParams)).to.be.true;
    });
    it('should return false for ToolRequestParameters without type or anyOf', () => {
        const paramsWithoutType = {
            properties: {
                param1: {
                    description: 'string'
                }
            },
            required: ['param1']
        };
        (0, chai_1.expect)(language_model_1.ToolRequest.isToolRequestParameters(paramsWithoutType)).to.be.false;
    });
    it('should return false for invalid ToolRequestParameters with wrong property type', () => {
        const invalidParams = {
            type: 'object',
            properties: {
                param1: {
                    type: 123
                }
            }
        };
        (0, chai_1.expect)(language_model_1.ToolRequest.isToolRequestParameters(invalidParams)).to.be.false;
    });
    it('should return false if properties is not an object', () => {
        const invalidParams = {
            type: 'object',
            properties: 'not-an-object',
        };
        (0, chai_1.expect)(language_model_1.ToolRequest.isToolRequestParameters(invalidParams)).to.be.false;
    });
    it('should return true if required is missing', () => {
        const missingRequiredParams = {
            type: 'object',
            properties: {
                param1: {
                    type: 'string'
                }
            }
        };
        (0, chai_1.expect)(language_model_1.ToolRequest.isToolRequestParameters(missingRequiredParams)).to.be.true;
    });
    it('should return false if required is not an array', () => {
        const invalidRequiredParams = {
            type: 'object',
            properties: {
                param1: {
                    type: 'string'
                }
            },
            required: 'param1'
        };
        (0, chai_1.expect)(language_model_1.ToolRequest.isToolRequestParameters(invalidRequiredParams)).to.be.false;
    });
    it('should return false if a required field is not a string', () => {
        const invalidRequiredParams = {
            type: 'object',
            properties: {
                param1: {
                    type: 'string'
                }
            },
            required: [123]
        };
        (0, chai_1.expect)(language_model_1.ToolRequest.isToolRequestParameters(invalidRequiredParams)).to.be.false;
    });
    it('should validate properties with anyOf correctly', () => {
        const paramsWithAnyOf = {
            type: 'object',
            properties: {
                param1: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'number' }
                    ]
                }
            },
            required: ['param1']
        };
        (0, chai_1.expect)(language_model_1.ToolRequest.isToolRequestParameters(paramsWithAnyOf)).to.be.true;
    });
});
//# sourceMappingURL=tool-request-parameters.spec.js.map