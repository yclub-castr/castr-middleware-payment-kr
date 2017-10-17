// app/payout/payout.route.js

'use strict';

const express = require('express');
const payoutService = require('./payout.service');
const opService = require('./op.service');

const router = express.Router();

/**
 * Get statements for ':business_id'
 */
router.get('/:business_id', (req, res) => {
    payoutService.getStatements(req, res);
});

/**
 * Get statement details for ':business_id'
 */
router.get('/:business_id/details/:statement_id', (req, res) => {
    payoutService.getStatementDetails(req, res);
});

module.exports = router;
