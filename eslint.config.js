import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

const typeProjects = [
  "./tsconfig.core.json",
  "./tsconfig.bun.json",
  "./tsconfig.tests.json",
  "./tsconfig.tests-bun.json",
  "./ui/web/tsconfig.json",
];

export default tseslint.config(
  {
    ignores: [
      "coverage/**",
      "node_modules/**",
      "ui/web/coverage/**",
      "ui/web/dist/**",
      "ui/web/node_modules/**",
      "ui/review/dist/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: { globals: globals.node },
    rules: {
      "eol-last": ["error", "always"],
      "no-tabs": "error",
      "no-trailing-spaces": "error",
    },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx}"],
  })),
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        project: typeProjects,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "eol-last": ["error", "always"],
      "no-tabs": "error",
      "no-trailing-spaces": "error",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
        ignoreRestSiblings: true,
        varsIgnorePattern: "^_"
      }],
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true, ignoreIIFE: true }],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "error",
    },
  },
  {
    files: [
      "src/integration/hooks.ts",
      "src/engine/observability.ts",
      "src/observability/agent-log.ts",
      "ui/web/src/store/**/*.{ts,tsx}",
    ],
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
  {
    files: ["src/observability/server/db.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "warn" },
  },
  {
    files: ["ui/web/src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
  {
    files: ["tests/**/*.{ts,tsx}", "ui/web/src/**/*.test.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },
);
