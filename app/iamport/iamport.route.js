// app/iamport/iamport.route.js

'use strict';

const express = require('express');
const IamportService = require('./iamport.service');

const router = express.Router();
const iamport_service = new IamportService();

router.get('/:business_id', (req, res) => {
    // Uses 'customer_uid' to retrieve the payment method
    iamport_service.getPaymentMethods(req, res);
});

/**
 * This route is used to manage payment methods. Each POST (with unique `customer_uid`) will create ONE payment method.
 * Every `customer_uid` should be mapped to corresponding business (via `business_id`) on our side, as I'mport does not provide such feature.
 *
 * - Provide the `customer_uid` to the path variable `:customer_uid` ( customer_uid = {business_id} + '_' + {card_last_4_digits} ).
 * - Once we call POST /customer/:customer_uid, we can use the `customer_uid` to request payment using the corresponding payment method.
 */
router.route('/:business_id/payment-method')
    .post((req, res) => {
        // Creates a customer (single payment method) using the provided 'customer_uid'
        iamport_service.createPaymentMethod(req, res);
    })
    .delete((req, res) => {
        // Uses 'customer_uid' to delete the payment method
        iamport_service.deletePaymentMethod(req, res);
    });

/**
 * Set the payment method as the default for this business.
 */
router.post('/:business_id/payment-method/:customer_uid', (req, res) => {
    IamportService.setAsDefault(req, res);
});

/**
 *
 */
router.post('/:business_id/subscribe', (req, res) => {
    // Processes a one-time payment with the provided `customer_uid`
    iamport_service.subscribe(req, res);
});

/*
 * Use the business_id (formerly restaurant_id) for the `merchant_uid`.
 * This will retrieve all the transaction history for a specific `merchant_uid` (which is mapped to a specific business).
*/
router.get('/:business_id/history', (req, res) => {
    // Retrieve all transaction hisotry for the provided `merchant_uid`
    IamportService.getHistory(req, res, [], 1);
});

router.route('/payment-hook')
    .post((req, res) => {
        // This endpoint will be reserved for Iamport to send success/failure result on payment transactions
        iamport_service.paymentHook(req, res);
    });

module.exports = router;
