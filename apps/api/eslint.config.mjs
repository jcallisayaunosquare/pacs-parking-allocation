// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Lint rules for the API.
 *
 * The package has had a `lint` script since it was written and it has never once run:
 * eslint was neither installed nor configured, so the command failed the moment CI
 * asked for it. This is that script made real.
 *
 * What it is NOT is a style enforcer. Formatting is not litigated here - nobody learns
 * anything from a build that fails over a quote character - and the rules that remain
 * are the ones that catch a defect: a floating promise, an unused export, an `any`
 * that quietly turns off the type system in a module that exists to model a domain.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', '.serverless/**', 'coverage/**', 'scripts/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      /*
       * An unused argument is usually a signature being honoured, which is fine; an
       * unused local is usually something half-removed. The underscore prefix is the
       * convention for saying "deliberately unused" out loud.
       */
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // `any` is a hole in the type system, and this codebase's whole argument is that
      // the domain is modelled in types. A warning rather than an error: the AWS SDK
      // forces a few, and failing a build over them teaches nothing.
      '@typescript-eslint/no-explicit-any': 'warn',
      // A non-null assertion is a claim the compiler cannot check, which is exactly
      // what the Result type in shared/result exists to avoid needing.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // Tests say things that are wrong in production code and right here: a fixture
    // cast to a partial shape, an expectation that a promise rejects.
    files: ['**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
