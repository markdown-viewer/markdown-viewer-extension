// Shared ESLint flat configuration. Advisory: adopt it rather than writing a
// repository-specific variant. Language plugins belong to the repository that
// needs them; this file defines the common baseline rules only.
export default [
  {
    ignores: [
      "artifacts/**",
      "build/**",
      "coverage/**",
      "dist/**",
      "node_modules/**",
      "output/**",
      "**/*.min.js",
    ],
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs", "**/*.ts", "**/*.tsx"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      eqeqeq: ["error", "always"],
      "no-var": "error",
      "prefer-const": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
];
