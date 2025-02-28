const express = require('express');
const router = express.Router();
const AWS = require('aws-sdk');

// Configure the AWS SDK
AWS.config.update({
  region: 'us-east-1', // Replace with your AWS region
});

// Create a DynamoDB client
const dynamoDB = new AWS.DynamoDB.DocumentClient();

const TABLE_NAME = 'FacebookPosts'; // Replace with your table name

// 1. Get a Single Item (by Partition Key and Sort Key)
async function getPost(pageId, timestamp) {
  const params = {
    TableName: TABLE_NAME,
    Key: {
      pageId: pageId,
      timestamp: timestamp,
    },
  };

  try {
    const result = await dynamoDB.get(params).promise();
    if (result.Item) {
      console.log('Retrieved post:', result.Item);
      return result.Item;
    } else {
      console.log('Post not found.');
      return null;
    }
  } catch (error) {
    console.error('Error getting post:', error);
    throw error;
  }
}

// 2. Query Items (Get all items for a specific pageId - using Partition Key)
async function getPostsForPage(pageId) {
  const params = {
    TableName: TABLE_NAME,
    KeyConditionExpression: 'pageId = :pageId',
    ExpressionAttributeValues: {
      ':pageId': pageId,
    },
  };

  try {
    const result = await dynamoDB.query(params).promise();
    console.log('Retrieved posts for pageId:', pageId, result.Items);
    return result.Items;
  } catch (error) {
    console.error('Error querying posts:', error);
    throw error;
  }
}

// 3. Scan the Entire Table (Use with Caution):
async function scanTable() {
  const params = {
    TableName: TABLE_NAME,
  };

  try {
    const result = await dynamoDB.scan(params).promise();
    console.log('Scanned table, items:', result.Items);
    return result.Items;
  } catch (error) {
    console.error('Error scanning table:', error);
    throw error;
  }
}

// Express routes to expose the DynamoDB functions as API endpoints
router.get('/posts/:pageId/:timestamp', async (req, res) => {
  try {
    const pageId = req.params.pageId;
    const timestamp = req.params.timestamp;
    const post = await getPost(pageId, timestamp);
    if (post) {
      res.json(post);
    } else {
      res.status(404).send('Post not found');
    }
  } catch (error) {
    console.error('Error in /posts/:pageId/:timestamp route:', error);
    res.status(500).json({ error: 'Failed to get post' });
  }
});

router.get('/posts/:pageId', async (req, res) => {
  try {
    const pageId = req.params.pageId;
    const posts = await getPostsForPage(pageId);
    res.json(posts);
  } catch (error) {
    console.error('Error in /posts/:pageId route:', error);
    res.status(500).json({ error: 'Failed to get posts for page' });
  }
});

router.get('/posts', async (req, res) => {
  try {
    const items = await scanTable();
    res.json(items);
  } catch (error) {
    console.error('Error in /posts route:', error);
    res.status(500).json({ error: 'Failed to scan table' });
  }
});

module.exports = router; // Export the router