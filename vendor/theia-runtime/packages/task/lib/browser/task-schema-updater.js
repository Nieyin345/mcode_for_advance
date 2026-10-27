"use strict";
// *****************************************************************************
// Copyright (C) 2019 Red Hat, Inc. and others.
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
// This file is inspired by VSCode and partially copied from https://github.com/Microsoft/vscode/blob/1.33.1/src/vs/workbench/contrib/tasks/common/problemMatcher.ts
// 'problemMatcher.ts' copyright:
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskSchemaUpdater = void 0;
const tslib_1 = require("tslib");
const Ajv = require("@theia/core/shared/ajv");
const debounce = require("p-debounce");
const inversify_1 = require("@theia/core/shared/inversify");
const json_schema_store_1 = require("@theia/core/lib/browser/json-schema-store");
const common_1 = require("@theia/core/lib/common");
const variable_input_schema_1 = require("@theia/variable-resolver/lib/browser/variable-input-schema");
const uri_1 = require("@theia/core/lib/common/uri");
const task_problem_matcher_registry_1 = require("./task-problem-matcher-registry");
const task_definition_registry_1 = require("./task-definition-registry");
const common_2 = require("../common");
const browser_1 = require("@theia/userstorage/lib/browser");
const browser_2 = require("@theia/workspace/lib/browser");
const task_preferences_1 = require("../common/task-preferences");
let TaskSchemaUpdater = class TaskSchemaUpdater {
    constructor() {
        this.onDidChangeTaskSchemaEmitter = new common_1.Emitter();
        this.onDidChangeTaskSchema = this.onDidChangeTaskSchemaEmitter.event;
        this.uri = new uri_1.default(task_preferences_1.taskSchemaId);
        this.update = debounce(() => this.doUpdate(), 0);
    }
    init() {
        this.jsonSchemaData.setSchema(this.uri, '');
        this.updateProblemMatcherNames();
        this.updateSupportedTaskTypes();
        // update problem matcher names in the task schema every time a problem matcher is added or disposed
        this.problemMatcherRegistry.onDidChangeProblemMatcher(() => this.updateProblemMatcherNames());
        // update supported task types in the task schema every time a task definition is registered or removed
        this.taskDefinitionRegistry.onDidRegisterTaskDefinition(() => this.updateSupportedTaskTypes());
        this.taskDefinitionRegistry.onDidUnregisterTaskDefinition(() => this.updateSupportedTaskTypes());
    }
    registerSchemas(context) {
        context.registerSchema({
            fileMatch: ['tasks.json', browser_1.UserStorageUri.resolve('tasks.json').toString()],
            url: this.uri.toString()
        });
        this.workspaceService.updateSchema('tasks', { $ref: this.uri.toString() });
    }
    doUpdate() {
        taskConfigurationSchema.anyOf = [processTaskConfigurationSchema, ...customizedDetectedTasks, ...customSchemas];
        const schema = this.getTaskSchema();
        this.doValidate = new Ajv().compile(schema);
        this.jsonSchemaData.setSchema(this.uri, schema);
        this.onDidChangeTaskSchemaEmitter.fire(undefined);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    validate(data) {
        return !!this.doValidate && !!this.doValidate(data);
    }
    /**
     * Adds given task schema to `taskConfigurationSchema` as `oneOf` subschema.
     * Replaces existed subschema by given schema if the corresponding `$id` properties are equal.
     *
     * Note: please provide `$id` property for subschema to have ability remove/replace it.
     * @param schema subschema for adding to `taskConfigurationSchema`
     */
    addSubschema(schema) {
        const schemaId = schema.$id;
        if (schemaId) {
            this.doRemoveSubschema(schemaId);
        }
        customSchemas.push(schema);
        this.update();
    }
    /**
     * Removes task subschema from `taskConfigurationSchema`.
     *
     * @param arg `$id` property of subschema
     */
    removeSubschema(arg) {
        const isRemoved = this.doRemoveSubschema(arg);
        if (isRemoved) {
            this.update();
        }
    }
    /**
     * Removes task subschema from `customSchemas`, use `update()` to apply the changes for `taskConfigurationSchema`.
     *
     * @param arg `$id` property of subschema
     * @returns `true` if subschema was removed, `false` otherwise
     */
    doRemoveSubschema(arg) {
        const index = customSchemas.findIndex(existed => !!existed.$id && existed.$id === arg);
        if (index > -1) {
            customSchemas.splice(index, 1);
            return true;
        }
        return false;
    }
    /** Returns an array of task types that are registered, including the default types */
    async getRegisteredTaskTypes() {
        const serverSupportedTypes = await this.taskServer.getRegisteredTaskTypes();
        const browserSupportedTypes = this.taskDefinitionRegistry.getAll().map(def => def.taskType);
        const allTypes = new Set([...serverSupportedTypes, ...browserSupportedTypes]);
        return Array.from(allTypes.values()).sort();
    }
    updateSchemasForRegisteredTasks() {
        customizedDetectedTasks.length = 0;
        const definitions = this.taskDefinitionRegistry.getAll();
        definitions.forEach(def => {
            const customizedDetectedTask = {
                type: 'object',
                required: ['type'],
                properties: {}
            };
            const taskType = {
                ...defaultTaskType,
                enum: [def.taskType],
                default: def.taskType,
                description: common_1.nls.localizeByDefault('The task type to customize')
            };
            customizedDetectedTask.properties.type = taskType;
            const required = def.properties.required || [];
            def.properties.all.forEach(taskProp => {
                if (required.find(requiredProp => requiredProp === taskProp)) { // property is mandatory
                    customizedDetectedTask.required.push(taskProp);
                }
                customizedDetectedTask.properties[taskProp] = { ...def.properties.schema.properties[taskProp] };
            });
            customizedDetectedTask.properties.label = taskLabel;
            customizedDetectedTask.properties.problemMatcher = problemMatcher;
            customizedDetectedTask.properties.presentation = presentation;
            customizedDetectedTask.properties.options = commandOptionsSchema;
            customizedDetectedTask.properties.group = group;
            customizedDetectedTask.properties.detail = detail;
            customizedDetectedTask.additionalProperties = true;
            customizedDetectedTasks.push(customizedDetectedTask);
        });
    }
    /** Returns the task's JSON schema */
    getTaskSchema() {
        return {
            type: 'object',
            default: { version: '2.0.0', tasks: [] },
            properties: {
                version: {
                    type: 'string',
                    default: '2.0.0',
                    description: common_1.nls.localizeByDefault("The config's version number.")
                },
                tasks: {
                    type: 'array',
                    items: {
                        ...(0, common_1.deepClone)(taskConfigurationSchema)
                    },
                    description: common_1.nls.localizeByDefault('The task configurations. Usually these are enrichments of task already defined in the external task runner.')
                },
                inputs: variable_input_schema_1.inputsSchema.definitions.inputs
            },
            additionalProperties: false,
            allowComments: true,
            allowTrailingCommas: true,
        };
    }
    /** Gets the most up-to-date names of problem matchers from the registry and update the task schema */
    updateProblemMatcherNames() {
        const matcherNames = this.problemMatcherRegistry.getAll().map(m => (0, common_2.asVariableName)(m.name));
        problemMatcherNames.length = 0;
        problemMatcherNames.push(...matcherNames);
        this.update();
    }
    async updateSupportedTaskTypes() {
        this.updateSchemasForRegisteredTasks();
        this.update();
    }
};
exports.TaskSchemaUpdater = TaskSchemaUpdater;
tslib_1.__decorate([
    (0, inversify_1.inject)(json_schema_store_1.JsonSchemaDataStore),
    tslib_1.__metadata("design:type", json_schema_store_1.JsonSchemaDataStore)
], TaskSchemaUpdater.prototype, "jsonSchemaData", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(task_problem_matcher_registry_1.ProblemMatcherRegistry),
    tslib_1.__metadata("design:type", task_problem_matcher_registry_1.ProblemMatcherRegistry)
], TaskSchemaUpdater.prototype, "problemMatcherRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(task_definition_registry_1.TaskDefinitionRegistry),
    tslib_1.__metadata("design:type", task_definition_registry_1.TaskDefinitionRegistry)
], TaskSchemaUpdater.prototype, "taskDefinitionRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_2.TaskServer),
    tslib_1.__metadata("design:type", Object)
], TaskSchemaUpdater.prototype, "taskServer", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_2.WorkspaceService),
    tslib_1.__metadata("design:type", browser_2.WorkspaceService)
], TaskSchemaUpdater.prototype, "workspaceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], TaskSchemaUpdater.prototype, "init", null);
exports.TaskSchemaUpdater = TaskSchemaUpdater = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], TaskSchemaUpdater);
const commandSchema = {
    type: 'string',
    description: common_1.nls.localizeByDefault('The command to be executed. Can be an external program or a shell command.')
};
const commandArgSchema = {
    type: 'array',
    description: common_1.nls.localizeByDefault('Arguments passed to the command when this task is invoked.'),
    items: {
        type: 'string'
    }
};
const commandOptionsSchema = {
    type: 'object',
    description: common_1.nls.localizeByDefault('Additional command options'),
    properties: {
        cwd: {
            type: 'string',
            description: common_1.nls.localize('theia/task/schema/commandOptions/cwd', "The current working directory of the executed program or script. If omitted Theia's current workspace root is used."),
            default: '${workspaceFolder}'
        },
        env: {
            type: 'object',
            description: common_1.nls.localizeByDefault("The environment of the executed program or shell. If omitted the parent process' environment is used.")
        },
        shell: {
            type: 'object',
            description: common_1.nls.localizeByDefault('Configures the shell to be used.'),
            properties: {
                executable: {
                    type: 'string',
                    description: common_1.nls.localizeByDefault('The shell to be used.')
                },
                args: {
                    type: 'array',
                    description: common_1.nls.localizeByDefault('The shell arguments.'),
                    items: {
                        type: 'string'
                    }
                }
            }
        }
    }
};
const problemMatcherNames = [];
const defaultTaskTypes = ['shell', 'process'];
const supportedTaskTypes = [...defaultTaskTypes];
const taskLabel = {
    type: 'string',
    description: common_1.nls.localizeByDefault("The task's user interface label")
};
const defaultTaskType = {
    type: 'string',
    enum: supportedTaskTypes,
    default: defaultTaskTypes[0],
    description: common_1.nls.localizeByDefault('Defines whether the task is run as a process or as a command inside a shell.')
};
const commandAndArgs = {
    command: commandSchema,
    args: commandArgSchema,
    options: commandOptionsSchema
};
const group = {
    oneOf: [
        {
            type: 'string',
            enum: ['build', 'test', 'none'],
            enumDescriptions: [
                common_1.nls.localizeByDefault("Marks the task as a build task accessible through the 'Run Build Task' command."),
                common_1.nls.localizeByDefault("Marks the task as a test task accessible through the 'Run Test Task' command."),
                common_1.nls.localizeByDefault('Assigns the task to no group')
            ]
        },
        {
            type: 'object',
            properties: {
                kind: {
                    type: 'string',
                    default: 'none',
                    description: common_1.nls.localizeByDefault("The task's execution group."),
                    enum: ['build', 'test', 'none'],
                    enumDescriptions: [
                        common_1.nls.localizeByDefault("Marks the task as a build task accessible through the 'Run Build Task' command."),
                        common_1.nls.localizeByDefault("Marks the task as a test task accessible through the 'Run Test Task' command."),
                        common_1.nls.localizeByDefault('Assigns the task to no group')
                    ]
                },
                isDefault: {
                    type: 'boolean',
                    default: false,
                    description: common_1.nls.localizeByDefault('Defines if this task is the default task in the group, or a glob to match the file which should trigger this task.')
                }
            }
        }
    ],
    description: common_1.nls.localizeByDefault('Defines to which execution group this task belongs to. It supports "build" to add it to the build group and "test" to add it to the test group.')
};
const problemPattern = {
    default: {
        regexp: '^([^\\\\s].*)\\\\((\\\\d+,\\\\d+)\\\\):\\\\s*(.*)$',
        file: 1,
        location: 2,
        message: 3
    },
    type: 'object',
    properties: {
        regexp: {
            type: 'string',
            description: common_1.nls.localizeByDefault('The regular expression to find an error, warning or info in the output.')
        },
        kind: {
            type: 'string',
            description: common_1.nls.localizeByDefault('whether the pattern matches a location (file and line) or only a file.')
        },
        file: {
            type: 'integer',
            description: common_1.nls.localizeByDefault('The match group index of the filename. If omitted 1 is used.')
        },
        location: {
            type: 'integer',
            // eslint-disable-next-line max-len
            description: common_1.nls.localizeByDefault("The match group index of the problem's location. Valid location patterns are: (line), (line,column) and (startLine,startColumn,endLine,endColumn). If omitted (line,column) is assumed.")
        },
        line: {
            type: 'integer',
            description: common_1.nls.localizeByDefault("The match group index of the problem's line. Defaults to 2")
        },
        column: {
            type: 'integer',
            description: common_1.nls.localizeByDefault("The match group index of the problem's line character. Defaults to 3")
        },
        endLine: {
            type: 'integer',
            description: common_1.nls.localizeByDefault("The match group index of the problem's end line. Defaults to undefined")
        },
        endColumn: {
            type: 'integer',
            description: common_1.nls.localizeByDefault("The match group index of the problem's end line character. Defaults to undefined")
        },
        severity: {
            type: 'integer',
            description: common_1.nls.localizeByDefault("The match group index of the problem's severity. Defaults to undefined")
        },
        code: {
            type: 'integer',
            description: common_1.nls.localizeByDefault("The match group index of the problem's code. Defaults to undefined")
        },
        message: {
            type: 'integer',
            description: common_1.nls.localizeByDefault('The match group index of the message. If omitted it defaults to 4 if location is specified. Otherwise it defaults to 5.')
        },
        loop: {
            type: 'boolean',
            // eslint-disable-next-line max-len
            description: common_1.nls.localizeByDefault('In a multi line matcher loop indicated whether this pattern is executed in a loop as long as it matches. Can only specified on a last pattern in a multi line pattern.')
        }
    }
};
const multiLineProblemPattern = {
    type: 'array',
    items: problemPattern
};
const watchingPattern = {
    type: 'object',
    additionalProperties: false,
    properties: {
        regexp: {
            type: 'string',
            description: common_1.nls.localizeByDefault('The regular expression to detect the begin or end of a background task.')
        },
        file: {
            type: 'integer',
            description: common_1.nls.localizeByDefault('The match group index of the filename. Can be omitted.')
        },
    }
};
const patternType = {
    anyOf: [
        {
            type: 'string',
            description: common_1.nls.localizeByDefault('The name of a contributed or predefined pattern')
        },
        problemPattern,
        multiLineProblemPattern
    ],
    description: common_1.nls.localizeByDefault('A problem pattern or the name of a contributed or predefined problem pattern. Can be omitted if base is specified.')
};
const problemMatcherObject = {
    type: 'object',
    properties: {
        base: {
            type: 'string',
            enum: problemMatcherNames,
            description: common_1.nls.localizeByDefault('The name of a base problem matcher to use.')
        },
        owner: {
            type: 'string',
            description: common_1.nls.localize('theia/task/schema/problemMatcherObject/owner', "The owner of the problem inside Theia. Can be omitted if base is specified. Defaults to 'external' if omitted and base is not specified.")
        },
        source: {
            type: 'string',
            description: common_1.nls.localizeByDefault("A human-readable string describing the source of this diagnostic, e.g. 'typescript' or 'super lint'.")
        },
        severity: {
            type: 'string',
            enum: ['error', 'warning', 'info'],
            description: common_1.nls.localizeByDefault("The default severity for captures problems. Is used if the pattern doesn't define a match group for severity.")
        },
        applyTo: {
            type: 'string',
            enum: ['allDocuments', 'openDocuments', 'closedDocuments'],
            description: common_1.nls.localizeByDefault('Controls if a problem reported on a text document is applied only to open, closed or all documents.')
        },
        pattern: patternType,
        fileLocation: {
            oneOf: [
                {
                    type: 'string',
                    enum: ['absolute', 'relative', 'autoDetect']
                },
                {
                    type: 'array',
                    items: {
                        type: 'string'
                    }
                }
            ],
            // eslint-disable-next-line max-len
            description: common_1.nls.localizeByDefault('Defines how file names reported in a problem pattern should be interpreted. A relative fileLocation may be an array, where the second element of the array is the path of the relative file location. The search fileLocation mode, performs a deep (and, possibly, heavy) file system search within the directories specified by the include/exclude properties of the second element (or the current workspace directory if not specified).')
        },
        background: {
            type: 'object',
            additionalProperties: false,
            description: common_1.nls.localizeByDefault('Patterns to track the begin and end of a matcher active on a background task.'),
            properties: {
                activeOnStart: {
                    type: 'boolean',
                    description: common_1.nls.localizeByDefault('If set to true the background monitor starts in active mode. This is the same as outputting a line that matches beginsPattern when the task starts.')
                },
                beginsPattern: {
                    oneOf: [
                        {
                            type: 'string'
                        },
                        watchingPattern
                    ],
                    description: common_1.nls.localizeByDefault('If matched in the output the start of a background task is signaled.')
                },
                endsPattern: {
                    oneOf: [
                        {
                            type: 'string'
                        },
                        watchingPattern
                    ],
                    description: common_1.nls.localizeByDefault('If matched in the output the end of a background task is signaled.')
                }
            }
        },
        watching: {
            type: 'object',
            additionalProperties: false,
            deprecationMessage: common_1.nls.localizeByDefault('The watching property is deprecated. Use background instead.'),
            description: common_1.nls.localizeByDefault('Patterns to track the begin and end of a watching matcher.'),
            properties: {
                activeOnStart: {
                    type: 'boolean',
                    description: common_1.nls.localizeByDefault('If set to true the watcher starts in active mode. This is the same as outputting a line that matches beginsPattern when the task starts.')
                },
                beginsPattern: {
                    oneOf: [
                        {
                            type: 'string'
                        },
                        watchingPattern
                    ],
                    description: common_1.nls.localizeByDefault('If matched in the output the start of a watching task is signaled.')
                },
                endsPattern: {
                    oneOf: [
                        {
                            type: 'string'
                        },
                        watchingPattern
                    ],
                    description: common_1.nls.localizeByDefault('If matched in the output the end of a watching task is signaled.')
                }
            }
        }
    }
};
const problemMatcher = {
    anyOf: [
        {
            type: 'string',
            enum: problemMatcherNames
        },
        {
            type: 'array',
            items: {
                type: 'string',
                enum: problemMatcherNames
            }
        },
        problemMatcherObject,
        {
            type: 'array',
            items: problemMatcherObject
        }
    ],
    description: common_1.nls.localizeByDefault('The problem matcher(s) to use. Can either be a string or a problem matcher definition or an array of strings and problem matchers.')
};
const presentation = {
    type: 'object',
    default: {
        echo: true,
        reveal: 'always',
        focus: false,
        panel: 'shared',
        showReuseMessage: true,
        clear: false
    },
    description: common_1.nls.localizeByDefault("Configures the panel that is used to present the task's output and reads its input."),
    additionalProperties: true,
    properties: {
        echo: {
            type: 'boolean',
            default: true,
            description: common_1.nls.localizeByDefault('Controls whether the executed command is echoed to the panel. Default is true.')
        },
        focus: {
            type: 'boolean',
            default: false,
            description: common_1.nls.localizeByDefault('Controls whether the panel takes focus. Default is false. If set to true the panel is revealed as well.')
        },
        reveal: {
            type: 'string',
            enum: ['always', 'silent', 'never'],
            enumDescriptions: [
                common_1.nls.localizeByDefault('Always reveals the terminal when this task is executed.'),
                common_1.nls.localizeByDefault('Only reveals the terminal if the task exits with an error or the problem matcher finds an error.'),
                common_1.nls.localizeByDefault('Never reveals the terminal when this task is executed.')
            ],
            default: 'always',
            description: common_1.nls.localizeByDefault('Controls whether the terminal running the task is revealed or not. May be overridden by option "revealProblems". Default is "always".')
        },
        panel: {
            type: 'string',
            enum: ['shared', 'dedicated', 'new'],
            enumDescriptions: [
                common_1.nls.localize('theia/task/schema/presentation/panel/shared', 'The terminal is shared and the output of other task runs are added to the same terminal.'),
                // eslint-disable-next-line max-len
                common_1.nls.localize('theia/task/schema/presentation/panel/dedicated', 'The terminal is dedicated to a specific task. If that task is executed again, the terminal is reused. However, the output of a different task is presented in a different terminal.'),
                common_1.nls.localize('theia/task/schema/presentation/panel/new', 'Every execution of that task is using a new clean terminal.')
            ],
            default: 'shared',
            description: common_1.nls.localizeByDefault('Controls if the panel is shared between tasks, dedicated to this task or a new one is created on every run.')
        },
        showReuseMessage: {
            type: 'boolean',
            default: true,
            description: common_1.nls.localize('theia/task/schema/presentation/showReuseMessage', 'Controls whether to show the "Terminal will be reused by tasks" message.')
        },
        clear: {
            type: 'boolean',
            default: false,
            description: common_1.nls.localizeByDefault('Controls whether the terminal is cleared before executing the task.')
        }
    }
};
const detail = {
    type: 'string',
    description: common_1.nls.localizeByDefault('An optional description of a task that shows in the Run Task quick pick as a detail.')
};
const taskIdentifier = {
    type: 'object',
    additionalProperties: true,
    properties: {
        type: {
            type: 'string',
            description: common_1.nls.localizeByDefault('The task identifier.')
        }
    }
};
const processTaskConfigurationSchema = {
    type: 'object',
    required: ['type', 'label', 'command'],
    properties: {
        label: taskLabel,
        type: defaultTaskType,
        ...commandAndArgs,
        isBackground: {
            type: 'boolean',
            default: false,
            description: common_1.nls.localizeByDefault('Whether the executed task is kept alive and is running in the background.')
        },
        dependsOn: {
            anyOf: [
                {
                    type: 'string',
                    description: common_1.nls.localizeByDefault('Another task this task depends on.')
                },
                taskIdentifier,
                {
                    type: 'array',
                    description: common_1.nls.localizeByDefault('The other tasks this task depends on.'),
                    items: {
                        anyOf: [
                            {
                                type: 'string'
                            },
                            taskIdentifier
                        ]
                    }
                }
            ],
            description: common_1.nls.localizeByDefault('Either a string representing another task or an array of other tasks that this task depends on.')
        },
        dependsOrder: {
            type: 'string',
            enum: ['parallel', 'sequence'],
            enumDescriptions: [
                common_1.nls.localizeByDefault('Run all dependsOn tasks in parallel.'),
                common_1.nls.localizeByDefault('Run all dependsOn tasks in sequence.')
            ],
            default: 'parallel',
            description: common_1.nls.localizeByDefault('Determines the order of the dependsOn tasks for this task. Note that this property is not recursive.')
        },
        windows: {
            type: 'object',
            description: common_1.nls.localizeByDefault('Windows specific command configuration'),
            properties: commandAndArgs
        },
        osx: {
            type: 'object',
            description: common_1.nls.localizeByDefault('Mac specific command configuration'),
            properties: commandAndArgs
        },
        linux: {
            type: 'object',
            description: common_1.nls.localizeByDefault('Linux specific command configuration'),
            properties: commandAndArgs
        },
        group,
        problemMatcher,
        presentation,
        detail,
    },
    additionalProperties: true
};
const customizedDetectedTasks = [];
const customSchemas = [];
const taskConfigurationSchema = {
    $id: task_preferences_1.taskSchemaId,
    anyOf: [processTaskConfigurationSchema, ...customizedDetectedTasks, ...customSchemas]
};
//# sourceMappingURL=task-schema-updater.js.map