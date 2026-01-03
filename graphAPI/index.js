require('dotenv').config(); // Load environment variables
const cors = require('cors');
const express = require('express');
const app = express();
const AWS = require('aws-sdk');
const { OpenAI } = require('openai');
const port = process.env.port || 4000;

const facebookRoutesvideo = require('./routes/facebookAPIvideo');
const facebookRoutesvideo2 = require('./routes/facebookAPIvideo2');
const facebookRoutesvideoV1 = require('./routes/facebookAPIvideoV1');
const getposts = require('./routes/getpostAPI');
const sql = require('mssql');
const iendorseRoutes = require('./routes/endorse');
const iendorseV1 = require('./routes/endorseV1');
const promoteRoutes = require('./routes/promote');
const promoteRoutesai = require('./routes/promoteai');
const engagementRoutes = require('./routes/engagement');
const imageTextRoutes = require('./routes/imagetext');
const ocrRoutes = require('./routes/ocrRoutes');
const ocropenaiRoutes = require('./routes/ocrOpenaiRoutes.js');
const aiVideoRoute = require('./routes/AiVideo_with_auto_stock.js');

// CORS Configuration
const allowedOrigins = [
  'https://www.iendorse.ng',
  'https://www.iendorse.ca',
  'https://www.iendorsenow.com'
];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true,
}));

// Middleware (Important: Body parsing BEFORE routes)
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Configure the AWS SDK
if (!process.env.AWS_EXECUTION_ENV) {
  // Local dev ONLY
  AWS.config.update({
    region: 'us-east-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  });
} else {
  // Lambda – rely on execution role
  AWS.config.update({
    region: process.env.AWS_REGION || 'us-east-1',
  });
}

const ssm = new AWS.SSM();

async function getAccessToken() {
  const param1 = {
    Name: '/iEndorse/Production/AccessToken',
    WithDecryption: true,
  };
  const param2 = {
    Name: '/iEndorse/Production/secretAccessKey',
    WithDecryption: true,
  };
  const param3 = {
    Name: '/iEndorse/Production/sqlpassword',
    WithDecryption: true,
  };
  const param4 = {
    Name: '/iEndorse/Production/OPENAI_API_KEY',
    WithDecryption: true,
  };

  // ✅ NEW: PEXELS API KEY
  const param5 = {
    Name: '/iEndorse/Production/PEXELS_API_KEY',
    WithDecryption: true,
  };

  try {
    const data1 = await ssm.getParameter(param1).promise();
    const data2 = await ssm.getParameter(param2).promise();
    const data3 = await ssm.getParameter(param3).promise();
    const data4 = await ssm.getParameter(param4).promise();
    const data5 = await ssm.getParameter(param5).promise();

    console.log("Successfully retrieved from Parameter Store");

    return {
      accessToken: data1.Parameter.Value,
      secretAccessKey: data2.Parameter.Value,
      sqlpassword: data3.Parameter.Value,
      openai_api_key: data4.Parameter.Value,
      pexels_api_key: data5.Parameter.Value, // ✅ NEW
    };
  } catch (err) {
    console.error('Error retrieving access token from SSM:', err);
    throw err;
  }
}

// Load the Tokens
let accessToken = null;
let secretAccessKey = null;
let sqlpassword = null;
let openai_api_key = null;
let pexels_api_key = null; // ✅ NEW
let tokenInitialized = false;

// Initialize and Refresh the token
async function initializeAccessToken() {
  console.log('Starting token initialization...');
  console.log('AWS_EXECUTION_ENV:', process.env.AWS_EXECUTION_ENV);
  console.log('AWS Region:', AWS.config.region);

  try {
    const credentials = await getAccessToken();
    accessToken = credentials.accessToken;
    secretAccessKey = credentials.secretAccessKey;
    sqlpassword = credentials.sqlpassword;
    openai_api_key = credentials.openai_api_key;
    pexels_api_key = credentials.pexels_api_key; // ✅ NEW
    tokenInitialized = true;

    console.log('All credentials retrieved successfully');
  } catch (error) {
    console.error('Failed to retrieve credentials during initialization:', error);
    console.error('Error code:', error.code);
    console.error('Error message:', error.message);
    tokenInitialized = false;
  }
}

// Initialize immediately
console.log('About to initialize credentials...');
const initPromise = initializeAccessToken();

// Middleware to ensure token is loaded before processing requests
app.use(async (req, res, next) => {
  if (!tokenInitialized) {
    console.log('Waiting for credential initialization...');
    await initPromise;
  }
  next();
});

// Set interval to check the token every hour
setInterval(async () => {
  try {
    const credentials = await getAccessToken();
    accessToken = credentials.accessToken;
    secretAccessKey = credentials.secretAccessKey;
    sqlpassword = credentials.sqlpassword;
    openai_api_key = credentials.openai_api_key;
    pexels_api_key = credentials.pexels_api_key; // ✅ NEW
    console.log('Credentials Refreshed');
  } catch (error) {
    console.error('Failed to refresh credentials:', error);
  }
}, 3600000);

// HEALTH CHECK ROUTE
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    port: port,
    accessTokenLoaded: !!accessToken,
    pexelsKeyLoaded: !!pexels_api_key,
  });
});

app.get('/', (req, res) => {
  if (!accessToken) {
    return res.status(500).send('Application failed to initialize: Access Token missing.');
  }
  res.send(`Hello World! Access Token: ${accessToken}, Page ID: ${process.env.PAGE_ID}`);
});

// Middleware to inject accessToken
app.use((req, res, next) => {
  if (!accessToken) {
    return res.status(500).send('Application failed to initialize: Access Token missing.');
  }
  req.accessToken = accessToken;
  req.openai_api_key = openai_api_key;
  req.pexels_api_key = pexels_api_key; // ✅ NEW
  next();
});

// Database configuration function
const getDbConfig = () => ({
  server: 'db5680.public.databaseasp.net',
  database: 'db5680',
  user: 'db5680',
  password: sqlpassword,
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true
  }
});

// Connect to database after initialization
async function connectToDatabase() {
  // Wait for credentials to be loaded
  if (!tokenInitialized) {
    await initPromise;
  }

  const config = getDbConfig();
  console.log('Attempting database connection to:', config.server);

  const pool = new sql.ConnectionPool(config);

  try {
    await pool.connect();
    console.log('Connected to SQL Server database');

    // Add connection error handler
    pool.on('error', err => {
      console.error('Database pool error:', err);
    });

    return pool;
  } catch (err) {
    console.error('Database connection failed:', err);
    console.error('Error details:', {
      code: err.code,
      message: err.message
    });
    throw err;
  }
}

// ===== OPTION 1: MIDDLEWARE TO ENSURE DATABASE CONNECTION =====
app.use(async (req, res, next) => {
  // Skip database check for health endpoint
  if (req.path === '/health' || req.path === '/') {
    return next();
  }

  // Check if database connection exists and is connected
  if (!app.locals.db || !app.locals.db.connected) {
    console.log('Database not connected, attempting to reconnect...');
    try {
      // Close existing connection if any
      if (app.locals.db) {
        try {
          await app.locals.db.close();
        } catch (closeErr) {
          console.log('Error closing existing pool:', closeErr.message);
        }
      }

      // Create new connection
      app.locals.db = await connectToDatabase();
      console.log('Database reconnected successfully');
    } catch (error) {
      console.error('Failed to reconnect to database:', error);
      return res.status(500).json({
        error: 'Database connection failed',
        details: error.message
      });
    }
  }

  next();
});
// ===== END DATABASE RECONNECTION MIDDLEWARE =====

// Define the routes
app.use('/', facebookRoutesvideo);
app.use('/', facebookRoutesvideo2);
app.use('/', facebookRoutesvideoV1);
app.use('/', getposts);
app.use('/', iendorseRoutes);
app.use('/', iendorseV1);
app.use('/', promoteRoutes);
app.use('/', engagementRoutes);
app.use('/', imageTextRoutes);
app.use('/', ocrRoutes);
app.use('/', ocropenaiRoutes);
app.use('/', promoteRoutesai);
app.use('/', aiVideoRoute);

module.exports = app;

// Initialize the database and start the server
connectToDatabase()
  .then(pool => {
    // Make the pool available to routes
    app.locals.db = pool;
    console.log('Database pool set in app.locals');

    // Only start server if not in Lambda
    if (process.env.AWS_EXECUTION_ENV === undefined) {
      app.listen(port, () => {
        console.log(`Server running on port ${port}`);
      });
    } else {
      console.log('Running in Lambda - server not started');
    }
  })
  .catch(err => {
    console.error('Failed to initialize database connection:', err);
    // In Lambda, don't exit - let the middleware handle reconnection
    if (process.env.AWS_EXECUTION_ENV === undefined) {
      process.exit(1);
    } else {
      console.log('Lambda will attempt reconnection on next request');
    }
  });

// Handle application shutdown
process.on('SIGINT', async () => {
  if (app.locals.db) {
    try {
      await app.locals.db.close();
      console.log('Database connection closed');
    } catch (err) {
      console.error('Error closing database connection:', err);
    }
  }
  process.exit(0);
});
