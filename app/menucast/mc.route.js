// app/menucast/mc.route.js

'use strict';

const express = require('express');
const mcService = require('./mc.service');
const iamportService = require('../iamport/iamport.service');

const router = express.Router();

/**
 * Get all payout transactions for ':business_id'
 */
router.get('/:business_id/coupon-redeem/:promotable_id', (req, res) => {
    mcService.couponRedeemHook(req, res);
});

/**
 * Process one-time Menucast purchases
 */
router.post('/:business_id/purchase/:promotable_id', (req, res) => {
    // Retrieve all transaction hisotry for the provided `merchant_uid`
    iamportService.mcPay(req, res);
});

/**
 * This endpoint will be reserved for Iamport to send success/failure result on payment transactions.
 */
router.route('/payment-hook')
    .post((req) => {
        iamportService.mcPaymentHook(req);
    });

module.exports = router;
