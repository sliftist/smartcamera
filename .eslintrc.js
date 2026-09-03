module.exports = {
    root: true,
    env: {
        browser: true,
        es6: true,
        node: true,
    },
    extends: [],
    globals: {
        Atomics: "readonly",
        SharedArrayBuffer: "readonly",
    },
    overrides: [
        {
            files: ["src/**/*.ts", "src/**/*.tsx"],
        },
    ],
    parser: "@typescript-eslint/parser",
    parserOptions: {
        ecmaVersion: 2018,
        sourceType: "module",
        project: "./tsconfig.json",
        tsconfigRootDir: __dirname,
    },
    plugins: ["@typescript-eslint"],
    rules: {
        "@typescript-eslint/no-floating-promises": ["error"],
        quotes: [
            "error",
            "double",
            {
                allowTemplateLiterals: true,
            },
        ],
        eqeqeq: "error",
        semi: "error",
    },
};
