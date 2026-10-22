import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    env: {
      NODE_ENV: 'test',
      SKILLHUB_PROFILE: 'yitan-official',
      PUBLIC_BASE_URL: 'https://skills.example.test/instance',
      DATABASE_URL: 'postgresql://127.0.0.1:5432/skillhub_test',
      JWT_SECRET: 'skillhub-test-jwt-secret-not-for-production',
    },
  },
})
