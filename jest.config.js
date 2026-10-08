const { loadEnv } = require("@medusajs/framework/utils")

loadEnv("test", process.cwd())

const config = {
  transform: {
    "^.+\\.[jt]s$": [
      "@swc/jest",
      {
        jsc: {
          parser: {
            syntax: "typescript",
            decorators: true,
          },
          target: "es2021",
        },
      },
    ],
  },
  testEnvironment: "node",
  moduleFileExtensions: ["js", "ts", "json"],
  modulePathIgnorePatterns: ["dist/", ".medusa/"],
  setupFiles: ["./integration-tests/setup.js"],
}

if (process.env.TEST_TYPE === "integration:http") {
  config.testMatch = ["**/integration-tests/http/*.spec.[jt]s"]
} else if (process.env.TEST_TYPE === "integration:modules") {
  config.testMatch = ["**/src/modules/*/__tests__/**/*.spec.[jt]s"]
} else if (process.env.TEST_TYPE === "unit") {
  // Pure-logic unit tests: no Medusa container, no PostgreSQL. Anything that
  // needs either belongs in the integration suites above.
  config.testMatch = ["**/src/**/__tests__/**/*.spec.[jt]s"]
  config.testPathIgnorePatterns = ["/node_modules/", "/src/modules/", "/src/admin/"]
  config.setupFiles = []
} else if (process.env.TEST_TYPE === "i18n") {
  config.testMatch = ["**/src/admin/i18n/__tests__/**/*.spec.[jt]s"]
  config.setupFiles = []
}

module.exports = config
