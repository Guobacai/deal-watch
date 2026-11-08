import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules", "extension/dist", "data", "logs"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The portal page runs in the browser as plain ES modules.
    files: ["public/**/*.js"],
    languageOptions: {
      globals: { document: "readonly", window: "readonly", fetch: "readonly", setInterval: "readonly", clearInterval: "readonly", localStorage: "readonly" },
    },
  },
);
