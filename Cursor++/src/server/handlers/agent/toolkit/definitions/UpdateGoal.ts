import { num } from '../shared';
import type { ToolRegistryEntry } from '../types';

const DESCRIPTION = `Update the status of the current conversation goal. Use active to resume it, paused when work cannot continue now, complete only after the objective is achieved, and cleared to remove it.`;

const STATUS_VALUES = ['active', 'paused', 'complete', 'cleared'];

const JSON_SCHEMA = {
    type: 'object',
    required: ['status'],
    properties: {
        status: {
            type: 'string',
            enum: STATUS_VALUES,
            description: 'The new goal status.',
        },
    },
};

export const UpdateGoalTool: ToolRegistryEntry = {
    canonicalName: 'UpdateGoal',
    aliases: ['UpdateGoal', 'update_goal'],
    cursorToolType: 'updateGoalToolCall',
    execArgsType: null,
    llmToolByProvider: {
        anthropic: {
            name: 'UpdateGoal',
            description: DESCRIPTION,
            inputSchema: JSON_SCHEMA,
        },
        openai: {
            name: 'UpdateGoal',
            description: DESCRIPTION,
            inputSchema: JSON_SCHEMA,
        },
        gemini: {
            name: 'UpdateGoal',
            description: DESCRIPTION,
            inputSchema: {
                type: 'OBJECT',
                required: ['status'],
                properties: {
                    status: {
                        type: 'STRING',
                        enum: STATUS_VALUES,
                        description: 'The new goal status.',
                    },
                },
            },
        },
    },
    buildStartedArgs: input => ({
        status: num(input.status),
    }),
};
