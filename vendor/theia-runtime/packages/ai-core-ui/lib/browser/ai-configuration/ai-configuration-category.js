"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource and others.
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
exports.AiConfigurationTools = exports.AiConfigurationCategoryId = exports.AiConfigurationCategoryOrder = exports.AiConfigurationCategory = void 0;
/**
 * Contribution point for a category shown in the AI Configuration view.
 *
 * Both built-in and externally contributed categories use this identical path;
 * there is no privileged API. Categories are collected via a
 * {@link ContributionProvider} and ordered by {@link AiConfigurationCategory.order}
 * by the {@link AiConfigurationCategoryRegistry}.
 */
exports.AiConfigurationCategory = Symbol('AiConfigurationCategory');
/**
 * Spaced ordering scale for the built-in categories, leaving room for
 * future built-ins and extensions to slot in between. Assigned to
 * {@link AiConfigurationCategory.order}. Categories with `contributed: true`
 * always sort after all built-ins, regardless of their `order`.
 */
var AiConfigurationCategoryOrder;
(function (AiConfigurationCategoryOrder) {
    AiConfigurationCategoryOrder.GENERAL = 100;
    AiConfigurationCategoryOrder.MODELS = 200;
    AiConfigurationCategoryOrder.MODEL_ALIASES = 300;
    AiConfigurationCategoryOrder.AGENTS = 400;
    AiConfigurationCategoryOrder.PROMPTS_AND_SKILLS = 500;
    AiConfigurationCategoryOrder.PROMPT_SNIPPETS = 550;
    AiConfigurationCategoryOrder.VARIABLES = 600;
    AiConfigurationCategoryOrder.MCP_SERVERS = 700;
    AiConfigurationCategoryOrder.TOOLS = 800;
    AiConfigurationCategoryOrder.TOKEN_USAGE = 900;
})(AiConfigurationCategoryOrder || (exports.AiConfigurationCategoryOrder = AiConfigurationCategoryOrder = {}));
/**
 * Canonical ids of the built-in categories. Shared so that the categories
 * (contributed from `ai-ide` and `ai-mcp`), navigation targets, and the legacy
 * `OPEN_AI_CONFIG_VIEW` tab-id mapping all reference the same stable strings.
 */
var AiConfigurationCategoryId;
(function (AiConfigurationCategoryId) {
    AiConfigurationCategoryId.GENERAL = 'general';
    AiConfigurationCategoryId.MODELS = 'models';
    AiConfigurationCategoryId.MODEL_ALIASES = 'model-aliases';
    AiConfigurationCategoryId.AGENTS = 'agents';
    AiConfigurationCategoryId.PROMPTS_AND_SKILLS = 'prompts-and-skills';
    AiConfigurationCategoryId.PROMPT_SNIPPETS = 'prompt-snippets';
    AiConfigurationCategoryId.VARIABLES = 'variables';
    AiConfigurationCategoryId.MCP_SERVERS = 'mcp-servers';
    AiConfigurationCategoryId.TOOLS = 'tools';
    AiConfigurationCategoryId.TOKEN_USAGE = 'token-usage';
})(AiConfigurationCategoryId || (exports.AiConfigurationCategoryId = AiConfigurationCategoryId = {}));
/**
 * Navigation into the Tools category's per-tool list. Shared here because the lists that link to it are
 * spread across packages (an agent's used tools in `@theia/ai-ide`, a server's tools in `@theia/ai-mcp`)
 * while the page itself lives in `@theia/ai-ide`, which those packages cannot all import.
 */
var AiConfigurationTools;
(function (AiConfigurationTools) {
    /**
     * Prefix of the `data-ai-config-row-id` the Tools page puts on each tool row. The tool's registry name
     * completes it — for an MCP tool that is `mcp_<server>_<tool>`, not the bare name shown per server.
     */
    AiConfigurationTools.ROW_ID_PREFIX = 'tool:';
    /** Navigation target that scrolls to and flashes `toolName`'s row, where its confirmation mode is set. */
    function selectionFor(toolName) {
        return {
            categoryId: AiConfigurationCategoryId.TOOLS,
            highlight: { rowId: AiConfigurationTools.ROW_ID_PREFIX + toolName }
        };
    }
    AiConfigurationTools.selectionFor = selectionFor;
})(AiConfigurationTools || (exports.AiConfigurationTools = AiConfigurationTools = {}));
//# sourceMappingURL=ai-configuration-category.js.map