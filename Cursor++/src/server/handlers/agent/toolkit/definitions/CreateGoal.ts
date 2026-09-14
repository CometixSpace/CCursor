import { str } from '../shared';
import type { ToolRegistryEntry } from '../types';

const DESCRIPTION = `Create a persistent goal for the current conversation. Use this when the user explicitly starts a goal with /goal. The objective must be concrete and describe the outcome to achieve.`;

const JSON_SCHEMA = {
    type: 'object',
    required: ['objective'],
    properties: {
        objective: {
            type: 'string',
            minLength: 1,
            description: 'The concrete objective for the goal.',
        },
    },
};

export const CreateGoalTool: ToolRegistryEntry = {
    canonicalName: 'CreateGoal',
    aliases: ['CreateGoal', 'create_goal'],
    cursorToolType: 'createGoalToolCall',
    execArgsType: null,
    llmToolByProvider: {
        anthropic: {
            name: 'CreateGoal',
            description: DESCRIPTION,
            inputSchema: JSON_SCHEMA,
        },
        openai: {
            name: 'CreateGoal',
            description: DESCRIPTION,
            inputSchema: JSON_SCHEMA,
        },
        gemini: {
            name: 'CreateGoal',
            description: DESCRIPTION,
            inputSchema: {
                type: 'OBJECT',
                required: ['objective'],
                properties: {
                    objective: {
                        type: 'STRING',
                        minLength: 1,
                        description: 'The concrete objective for the goal.',
                    },
                },
            },
        },
    },
    buildStartedArgs: input => ({
        objective: str(input.objective),
    }),
};
