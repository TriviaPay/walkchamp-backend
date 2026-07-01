import app from "./app.js";
import { logger } from "./lib/logger.js";
import { config } from "./lib/config.js";

app.listen(config.port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port: config.port, trustProxy: config.trustProxy }, "Server listening");
});
