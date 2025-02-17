require('dotenv').config(); // Load environment variables
const cors = require('cors');

const express = require('express');
const app = express();
const port = process.env.PORT || 5000;
const facebookRoutes = require('./routes/facebookAPI'); // Import the route

app.use(cors({ origin: '*' }));

// Middleware (Important:  Body parsing BEFORE routes)
app.use(express.json());       // Parse JSON request bodies
app.use(express.urlencoded({ extended: true }));  // Parse URL-encoded bodies

// Use the Facebook API routes
app.use('/', facebookRoutes); // Mount the routes at the root path

// Start the server
app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});