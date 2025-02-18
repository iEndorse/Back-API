require('dotenv').config(); // Load environment variables
const cors = require('cors');

const express = require('express');
const app = express();
const port = process.env.PORT || 3000;
const facebookRoutes = require('./routes/facebookAPI'); // Import the route
const facebookRoutesphotoV1 = require('./routes/facebookAPIphotoV1'); // Import the route
const facebookRoutesvideo = require('./routes/facebookAPIvideo'); // Import the route
const facebookRoutesvideo2 = require('./routes/facebookAPIvideo2'); // Import the route
const facebookRoutesvideoV1 = require('./routes/facebookAPIvideoV1'); // Import the route


app.use(cors({ origin: '*' }));

// Middleware (Important:  Body parsing BEFORE routes)
app.use(express.json());       // Parse JSON request bodies
app.use(express.urlencoded({ extended: true }));  // Parse URL-encoded bodies

// Use the Facebook API routes
app.use('/', facebookRoutesphotoV1); // Mount the routes at the root path
app.use('/', facebookRoutesvideo); // Mount the routes at the root path
app.use('/', facebookRoutesvideo2); // Mount the routes at the root path
app.use('/', facebookRoutesvideoV1); // Mount the routes at the root path


// Start the server
app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});