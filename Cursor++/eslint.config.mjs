import antfu from '@antfu/eslint-config'

const coreRuntimeFiles = [
  'src/server/handlers/**',
  'src/server/services/**',
  'src/server/database/**',
]

const presets = await antfu({
  typescript: true,
  isInEditor: false,
  ignores: [
    'src/server/gen/**',
    'dist/**',
    'out/**',
    'obfuscate.js',
    'esbuild.js',
    'package.json',
    'tsconfig.json',
  ],
}, {
  rules: {
    'no-console': 'off',
    'node/prefer-global/process': 'off',
    'node/prefer-global/buffer': 'off',
    'ts/no-require-imports': 'off',
  },
})

const plugins = Object.assign({}, ...presets.map(preset => preset.plugins))

// Core runtime joins correctness lint without a repository-wide style rewrite.
// Keep parser/plugin setup and problem rules active everywhere; defer only
// plugin-classified layout and suggestion rules for these legacy directories.
const scopedPresets = presets.flatMap((preset) => {
  if (!preset.rules)
    return [preset]

  const correctnessRules = {}
  const conventionRules = {}
  for (const [ruleName, configuration] of Object.entries(preset.rules)) {
    const separator = ruleName.indexOf('/')
    const rule = separator < 0
      ? undefined
      : plugins[ruleName.slice(0, separator)]?.rules?.[ruleName.slice(separator + 1)]
    const isConvention = rule?.meta?.type === 'layout' || rule?.meta?.type === 'suggestion'
    const targetRules = isConvention ? conventionRules : correctnessRules
    targetRules[ruleName] = configuration
  }

  return [
    { ...preset, rules: correctnessRules },
    {
      name: `${preset.name ?? 'project'}/conventions`,
      ...(preset.files ? { files: preset.files } : {}),
      ignores: [...(preset.ignores ?? []), ...coreRuntimeFiles],
      rules: conventionRules,
    },
  ]
})

export default [
  ...scopedPresets,
  {
    name: 'ccursor/core-correctness',
    files: coreRuntimeFiles,
    // The TypeScript preset disables this rule, but strict does not reject
    // unreachable statements unless allowUnreachableCode is explicitly false.
    rules: { 'no-unreachable': 'error' },
  },
]
