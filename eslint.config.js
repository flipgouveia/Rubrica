import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import i18next from "eslint-plugin-i18next";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist", "src-tauri", "src/ipc/bindings.ts", "fixtures/.generated"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
      i18next,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      // CONTRACTS §7: zero hardcoded user-facing strings — everything through i18next.
      "i18next/no-literal-string": [
        "error",
        {
          mode: "jsx-text-only",
          "jsx-attributes": {
            include: ["title", "placeholder", "aria-label", "alt"],
          },
        },
      ],
    },
  },
  {
    // Test files aren't user-facing UI — literal strings in render()/assertion
    // fixtures don't need to route through i18next.
    files: ["**/*.{test,spec}.{ts,tsx}"],
    rules: {
      "i18next/no-literal-string": "off",
    },
  },
);
