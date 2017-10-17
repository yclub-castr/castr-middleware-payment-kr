// app/iamport/iamport.route.js

'use strict';

const express = require('express');
const iamportService = require('./iamport.service');

const router = express.Router();

/**
 * Get all payment methods under ':business_id'
 */
router.get('/:business_id', (req, res) => {
    // Uses 'customer_uid' to retrieve the payment method
    iamportService.getPlan(req, res);
});

/**
 * This route is used to manage payment methods. Each POST (with unique `customer_uid`) will create ONE payment method.
 * Every `customer_uid` should be mapped to corresponding business (via `business_id`) on our side, as I'mport does not provide such feature.
 *
 * - Provide the `customer_uid` to the path variable `:customer_uid` ( customer_uid = {business_id} + '_' + {card_last_4_digits} ).
 * - Once we call POST /customer/:customer_uid, we can use the `customer_uid` to request payment using the corresponding payment method.
 */
router.route('/:business_id/payment-method')
    .get((req, res) => {
        // Creates a customer (single payment method) using the provided 'customer_uid'
        iamportService.getPaymentMethods(req, res);
    })
    .post((req, res) => {
        // Creates a customer (single payment method) using the provided 'customer_uid'
        iamportService.savePaymentMethod(req, res);
    })
    .delete((req, res) => {
        // Uses 'customer_uid' to delete the payment method
        iamportService.deletePaymentMethod(req, res);
    });

/**
 * Set the payment method as the default for this business.
 */
router.post('/:business_id/payment-method/:customer_uid', (req, res) => {
    iamportService.setAsDefault(req, res);
});

/**
 *
 */
router.route('/:business_id/subscription')
    .post((req, res) => {
        // Processes a one-time payment with the provided `customer_uid`
        iamportService.subscribe(req, res);
    })
    .put((req, res) => {
        // Change subscription billing plan
        iamportService.changeSubscription(req, res);
    })
    .delete((req, res) => {
        // Refund service fee for the current billing cycle (80% of prorated)
        iamportService.refund(req, res);
    });

/**
 * Stop next scheduled payment until resumed
 */
router.post('/:business_id/pause', (req, res) => {
    iamportService.pause(req, res);
});

/**
 * Process paused scheduled payment
 */
router.post('/:business_id/resume', (req, res) => {
    iamportService.resume(req, res);
});

/*
 * Use the business_id (formerly restaurant_id) for the `merchant_uid`.
 * This will retrieve all the transaction history for a specific `merchant_uid` (which is mapped to a specific business).
*/
router.get('/:business_id/history', (req, res) => {
    // Retrieve all transaction hisotry for the provided `merchant_uid`
    iamportService.getHistory(req, res);
});

module.exports = router;
