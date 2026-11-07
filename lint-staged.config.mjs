export default {
  '{src,tests,scripts,evaluations/fixtures}/**/*.{ts,tsx,js,mjs,cjs}': [
    'eslint --fix --max-warnings=0',
    'prettier --write',
  ],
  '*.config.{ts,js,mjs,cjs}': ['eslint --fix --max-warnings=0', 'prettier --write'],
  '*.{css,html,json,yaml,yml,md}': 'prettier --write --ignore-unknown',
};
