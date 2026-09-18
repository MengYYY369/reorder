import { defineConfig, loadEnv } from "@medusajs/framework/utils"
import path from "path"

const projectRoot = path.resolve(__dirname, "..")

loadEnv(process.env.NODE_ENV || "test", projectRoot)

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    http: {
      jwtSecret: process.env.JWT_SECRET || "supersecret",
      cookieSecret: process.env.COOKIE_SECRET || "supersecret",
      storeCors: process.env.STORE_CORS || "",
      adminCors: process.env.ADMIN_CORS || "",
      authCors: process.env.AUTH_CORS || "",
    },
  },
  plugins: [
    {
      resolve: projectRoot,
      options: {
        saas_bridge: {
          // Endpoints active for the contract tests; the whitelist stays
          // empty — the medusa-webhooks optional peer is not installed in
          // this repo and nothing may be forwarded from the test env.
          shared_secret: "test-bridge-secret",
          subscriptions: [],
        },
      },
    },
  ],
})
