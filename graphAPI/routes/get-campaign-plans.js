/**
 * @file get-campaign-plans.js
 * @description GET endpoint to fetch available campaign promotion plans from CampaignSubscriptions table.
 *              Used by the frontend when the user clicks the "Promote" button.
 *
 * Response format:
 * {
 *   "success": true,
 *   "plans": [
 *     {
 *       "planUniqueId": "bronze",
 *       "planName": "Meta Ads - 1 Day Boost",
 *       "campaignPlanUnit": 1500,
 *       "amount": 1500
 *     },
 *     ...
 *   ]
 * }
 */

'use strict';

const express = require('express');
const sql     = require('mssql');
const router  = express.Router();

router.use(express.json());
router.use(express.urlencoded({ extended: true }));

/**
 * GET /campaign-plans
 *
 * Fetches all available campaign promotion plans from the CampaignSubscriptions table.
 * No authentication required (plans are public information).
 *
 * Query Parameters: None
 *
 * Response:
 *   200 - Success with plans array
 *   500 - Database error
 */
router.get('/campaign-plans', async (req, res) => {
    try {
        const pool = req.app.locals.db;

        if (!pool) {
            return res.status(500).json({
                error: 'Database connection is not available'
            });
        }

        // Fetch all campaign subscription plans ordered by CampaignPlanUnit (ascending)
        // so frontend gets them in logical order: bronze → silver → gold → platinum
        const result = await pool.request().query(`
            SELECT
                PlanUniqueId      AS planUniqueId,
                PlanName          AS planName,
                CampaignPlanUnit  AS campaignPlanUnit,
                Amount            AS amount
            FROM CampaignSubscriptions
            ORDER BY CampaignPlanUnit ASC
        `);

        return res.status(200).json({
            success: true,
            plans:   result.recordset
        });

    } catch (err) {
        console.error('[get-campaign-plans] Database error:', err);
        return res.status(500).json({
            error:   'Failed to fetch campaign plans',
            details: err.message
        });
    }
});

module.exports = router;