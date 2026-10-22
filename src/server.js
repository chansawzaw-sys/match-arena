'use strict';
const { loadConfig } = require('./config');
const { createApp } = require('./app');

const config = loadConfig();
const app = createApp(config);
app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Match Arena Part 1 listening on http://localhost:${config.port} (NODE_ENV=${config.nodeEnv}, demo login ${config.demoLoginEnabled ? 'enabled' : 'disabled'})`);
});
