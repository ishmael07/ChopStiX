import { defineConfig } from 'vitest/config';
// Each database test file boots its own PGlite in beforeAll; several at once can take well over the 10s default.
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], testTimeout: 30000, hookTimeout: 30000 } });
