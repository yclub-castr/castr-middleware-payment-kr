const express = require('express');
const iamportService = require('./iamport.service');

const router = express.Router();

// 'host/payment'

router.get('/:business_id', function (req, res) {
    // Uses 'customer_uid' to retrieve the payment method
    iamportService.getPaymentMethods(req, res);
})

/**
 * This route is used to manage payment methods. Each POST (with unique `customer_uid`) will create ONE payment method. 
 * Every `customer_uid` should be mapped to corresponding business (via `business_id`) on our side, as I'mport does not provide such feature.
 * 
 * - Provide the `customer_uid` to the path variable `:customer_uid` ( customer_uid = {business_id} + '_' + {card_last_4_digits} ).
 * - Once we call POST /customer/:customer_uid, we can use the `customer_uid` to request payment using the corresponding payment method.
 */
router.route('/:business_id/payment-method')
    .post(function (req, res) {
        // Creates a customer (single payment method) using the provided 'customer_uid'
        iamportService.createPaymentMethod(req, res);
    })
    .delete(function (req, res) {
        // Uses 'customer_uid' to delete the payment method
        iamportService.deletePaymentMethod(req, res);
    });


/** 
 * 
 */
router.post('/:business_id/subscribe', function (req, res) {
    // Processes a one-time payment with the provided `customer_uid`
    iamportService.subscribe(req, res);
});

router.post('/:business_id/unsubscribe', function (req, res) {
    // Cancel all scheduled payments for the provided `customer_uid`
    iamportService.unsubscribe(req, res);
});

/*
 * Use the business_id (formerly restaurant_id) for the `merchant_uid`.
 * This will retrieve all the transaction history for a specific `merchant_uid` (which is mapped to a specific business).
*/
router.get('/:customer_uid/history', function (req, res) {
    // Retrieve all transaction hisotry for the provided `merchant_uid`
    iamportService.getHistory(req, res, [], 1);
})

router.route('/payment-hook')
    .post(function (req, res) {
        // This endpoint will be reserved for Iamport to send success/failure result on payment transactions
        iamportService.paymentHook(req, res);
    });

module.exports = router