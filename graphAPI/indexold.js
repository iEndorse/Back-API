const express = require('express');
const AWS = require('aws-sdk');
const app = express();
const port = 5000;
const facebookRoutesphotoV1 = require('./routes/facebookAPIphotoV1'); // Import the route
const facebookRoutesvideo = require('./routes/facebookAPIvideo'); // Import the route
const facebookRoutesvideo2 = require('./routes/facebookAPIvideo2'); // Import the route
const facebookRoutesvideoV1 = require('./routes/facebookAPIvideoV1'); // Import the route

// Enable CORS
app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

// Middleware (Important:  Body parsing BEFORE routes)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configure the AWS SDK
AWS.config.update({
  region: 'us-east-1',
});

const ssm = new AWS.SSM();

async function getAccessToken() {
  const params = {
    Name: '/iEndorse/Production/AccessToken',
    WithDecryption: true,
  };

  try {
    const data = await ssm.getParameter(params).promise();
    console.log("Successfully retrieved from Parameter Store")
    return data.Parameter.Value;
  } catch (err) {
    console.error('Error retrieving access token from SSM:', err);
    throw err; // Re-throw the error to be caught later
  }
}

// Load the Access Token
let accessToken = null;
(async () => {
  try {
    accessToken = await getAccessToken();
    console.log('Access Token Retrieved during initialization:', accessToken); // Add for verification
  } catch (error) {
    console.error('Failed to retrieve access token during initialization, shutting down:', error);
    process.exit(1);  // Exit the application if it fails to load the token
  }
})();


app.get('/', (req, res) => {
  if (!accessToken) {
    return res.status(500).send('Application failed to initialize: Access Token missing.');
  }
  res.send(`Hello World!  Access Token: ${accessToken}, Page ID: ${process.env.PAGE_ID}`);
});

// Middleware to inject accessToken
app.use((req, res, next) => {
    if (!accessToken) {
        return res.status(500).send('Application failed to initialize: Access Token missing.');
    }
    req.accessToken = accessToken;
    next();
});

// Use the Facebook API routes
app.use('/', facebookRoutesphotoV1); // Mount the routes at the root path
app.use('/', facebookRoutesvideo); // Mount the routes at the root path
app.use('/', facebookRoutesvideo2); // Mount the routes at the root path
app.use('/', facebookRoutesvideoV1); // Mount the routes at the root path

// Start the server
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});