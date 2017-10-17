// app/payout/payout.route.js

'use strict';

const express = require('express');
const payoutService = require('./payout.service');
const opService = require('./op.service');

const router = express.Router();

/**
 * Get all payout transactions for ':business_id'
 */
router.get('/:business_id', (req, res) => {
    payoutService.getHistory(req, res);
});

module.exports = router;