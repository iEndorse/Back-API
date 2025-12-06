require('dotenv').config(); // Load environment variables
const cors = require('cors');
const express = require('express');
const app = express();
const AWS = require('aws-sdk');
const { OpenAI } = require('openai');
const port =process.env.port || 4000;

const facebookRoutesvideo = require('./routes/facebookAPIvideo'); // Import the route
const facebookRoutesvideo2 = require('./routes/facebookAPIvideo2'); // Import the route
const facebookRoutesvideoV1 = require('./routes/facebookAPIvideoV1'); // Import the route
const getposts = require('./routes/getpostAPI'); // Import the route
const sql = require('mssql');
const iendorseRoutes = require('./routes/endorse');
const iendorseV1 = require('./routes/endorseV1');
const boost = require('./routes/boost');
const promoteRoutes = require('./routes/promote');
const promoteRoutesai = require('./routes/promoteai');
const engagementRoutes = require('./routes/engagement');
const imageTextRoutes = require('./routes/imagetext'); // Import the route
const ocrRoutes = require('./routes/ocrRoutes');
const ocropenaiRoutes = require('./routes/ocrOpenaiRoutes.js'); // Import the route
const aiVideoRoute = require('./routes/AiVideo.js'); // Import the route
//const openaiRoutes = require('./routes/ocr-ai'); // Import the route
// Enable CORS
//app.use(function (req, res, next) {
  //  res.header("Access-Control-Allow-Origin", "*");
   // res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
   // next();
//});


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


// HEALTH CHECK ROUTE - Define this BEFORE other middleware that might block it
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        port: port, // Fixed: use the port variable, not process.env.port
        accessTokenLoaded: !!accessToken // Shows if token is loaded without exposing it
    });
});

// Middleware (Important: Body parsing BEFORE routes)
app.use(express.urlencoded({ extended: true })); // For form data
app.use(express.json()); // For JSON data

// Configure the AWS SDK
// Configure the AWS SDK
// AWS.config.update({
//   region: 'us-east-1',
//   accessKeyId: process.env.AWS_ACCESS_KEY_ID, // Required for all types of testing
//   secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
// });



if (!process.env.AWS_EXECUTION_ENV) {
    // Local dev ONLY
    AWS.config.update({
        region: 'us-east-1',
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    });
} else {
    // Lambda – rely on role/region
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

  try {
    const data1 = await ssm.getParameter(param1).promise();
    const data2 = await ssm.getParameter(param2).promise();
    const data3 = await ssm.getParameter(param3).promise();
    const data4 = await ssm.getParameter(param4).promise();
    console.log("Successfully retrieved from Parameter Store");
    
    return {
      accessToken: data1.Parameter.Value,
      secretAccessKey: data2.Parameter.Value,
      sqlpassword: data3.Parameter.Value,
      openai_api_key: data4.Parameter.Value
    };
  } catch (err) {
    console.error('Error retrieving access token from SSM:', err);
    throw err; // Re-throw the error to be caught later
  }
}

// Load the Tokens
let accessToken = null;
let secretAccessKey = null;
let sqlpassword = null;
let openai_api_key = null;

// Initialize and Refresh the token
async function initializeAccessToken() {
  try {
    // Update to handle the new returned object structure
    const credentials = await getAccessToken();
    accessToken = credentials.accessToken;
    secretAccessKey = credentials.secretAccessKey;
    sqlpassword = credentials.sqlpassword;
    openai_api_key = credentials.openai_api_key;
    
    console.log('Access Token Retrieved during initialization:', accessToken);
    console.log('Secret Access Key Retrieved during initialization:', secretAccessKey);
    console.log('SQL DB password Key Retrieved during initialization:', sqlpassword);
    console.log('OpenAI API Key Retrieved during initialization:', openai_api_key);
  } catch (error) {
    console.error('Failed to retrieve access token during initialization, shutting down:', error);
    process.exit(1); // Exit the application if it fails to load the token
  }
}

// Set interval to check the token every 10 minutes (600000 ms)
setInterval(async () => {
    try {
        const credentials = await getAccessToken();
        accessToken = credentials.accessToken;
        secretAccessKey = credentials.secretAccessKey;
        sqlpassword = credentials.sqlpassword;
        openai_api_key = credentials.openai_api_key;
        console.log('Credentials Refreshed');
    } catch (error) {
        console.error('Failed to refresh credentials:', error);
    }
}, 3600000);

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
    next();
});

// Database configuration function to always get the latest credentials
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
  // Make sure we have the credentials first
  await initializeAccessToken();
  
  const pool = new sql.ConnectionPool(getDbConfig());
  
  try {
    await pool.connect();
    console.log('Connected to SQL Server database');
    return pool;
  } catch (err) {
    console.error('Database connection failed:', err);
    throw err;
  }
}

// Define the routes

app.use('/', facebookRoutesvideo);
app.use('/', facebookRoutesvideo2);
app.use('/', facebookRoutesvideoV1);
app.use('/', getposts);
app.use('/', iendorseRoutes);
app.use('/', iendorseV1);
app.use('/', boost);
app.use('/', promoteRoutes);
app.use('/', engagementRoutes);
app.use('/', imageTextRoutes); // Use the image text route
app.use('/', ocrRoutes);
app.use('/', ocropenaiRoutes); // Use the OCR Azure route
app.use('/', promoteRoutesai);
app.use('/', aiVideoRoute);
 //app.use('/', openaiRoutes); // Use the OpenAI route

// Basic route (Note: this is defined twice in your original code)
app.get('/', (req, res) => {
  res.send('API is running');
});

module.exports = app;
// Initialize the database and start the server
connectToDatabase()
  .then(pool => {
    // Make the pool available to routes
    app.locals.db = pool;
    
    // Start the server
    // app.listen(port, () => {
    //   console.log(`Server running on port ${port}`);
    // });

    // Only start server if not in Lambda
if (process.env.AWS_EXECUTION_ENV === undefined) {
    app.listen(3000, () => {
        console.log('Server running on port 3000');
    });
}


  })
  .catch(err => {
    console.error('Failed to initialize database connection:', err);
    process.exit(1);
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
