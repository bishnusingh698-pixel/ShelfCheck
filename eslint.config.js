import eslint from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import globals from "globals";

/**
 * Brand terms may appear as literal JSX text (logos, codes).
 * Everything else user-facing must go through t().
 */
const BRAND = new Set(["ShelfCheck", "Shopify", "Telegram", "Matrixify", "SKU", "GTIN", "CSV"]);

const localPlugin = {
  rules: {
    /** No hard-coded user-facing JSX text (spec <localization> §2). */
    "jsx-no-literals": {
      meta: {
        type: "problem",
        schema: [],
        messages: { literal: "Hard-coded JSX text: {{text}} — use t('key') from locales/en.json." },
      },
      create(context) {
        return {
          JSXText(node) {
            const text = node.value.trim();
            if (!text || BRAND.has(text)) return;
            // Codes, numbers, punctuation-only, and single letters pass.
            if (!/\p{Ll}{2,}/u.test(text)) return;
            context.report({ node, messageId: "literal", data: { text: text.slice(0, 40) } });
          },
        };
      },
    },
    /** Logical CSS properties only (spec <localization> §8: no physical left/right). */
    "no-physical-css": {
      meta: {
        type: "problem",
        schema: [],
        messages: { physical: "Physical CSS property '{{key}}' — use logical properties (inline-start/end, margin-inline…)." },
      },
      create(context) {
        const PHYSICAL =
          /^(left|right|margin-left|margin-right|padding-left|padding-right|border-left|border-right|inset-left|inset-right|text-align)$/;
        const kebab = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
        return {
          Property(node) {
            const attr = node.parent?.parent;
            if (!attr || attr.type !== "JSXAttribute" || attr.name?.name !== "style") return;
            const keyName = node.key.type === "Identifier" ? node.key.name : node.key.type === "Literal" ? node.key.value : null;
            if (keyName == null) return;
            if (!PHYSICAL.test(kebab(keyName))) return;
            if (kebab(keyName) === "text-align") {
              const v = node.value;
              const val = v?.type === "Literal" ? v.value : null;
              if (val !== "left" && val !== "right") return;
            }
            context.report({ node, messageId: "physical", data: { key: kebab(keyName) } });
          },
        };
      },
    },
  },
};

const NODE_AND_BROWSER = {
  ...globals.node,
  ...globals.browser,
};

export default [
  {
    ignores: [
      "node_modules",
      "build",
      ".react-router",
      "tests/fixtures",
      "playwright-report",
      "locales/en-XA.json",
      "public",
      "app/types/**", // generated (graphql-codegen)
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs["flat/recommended"],
  {
    files: ["**/*.{ts,tsx,mjs}"],
    plugins: { local: localPlugin },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: NODE_AND_BROWSER,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "local/jsx-no-literals": "error",
      "local/no-physical-css": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Server/build scripts print to stdout by design.
    files: ["scripts/**", "server/**"],
    rules: { "no-console": "off" },
  },
];
