
const serverless = require('serverless-http');
const app = require('./index');

module.exports.handler = serverless(app, {
  binary: ["audio/mpeg", "audio/*", "application/octet-stream"],
});

//module.exports.handler = serverless(app);





