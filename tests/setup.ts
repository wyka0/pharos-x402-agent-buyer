import { config as dotenvConfig } from "dotenv";
import { resolve } from "node:path";

// Load the project's .env.local so integration-style tests can read chain
// constants. Tests never depend on secrets: settlement and probing are always
// mocked in unit/integration tests.
dotenvConfig({ path: resolve(__dirname, "../.env.local"), quiet: true });
