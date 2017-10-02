const express = require('express');
const mongoDB = require('../db');
const iamportService = require('./iamport.service');

const router = express.Router();

// 'host/iamport'

router.route('/token')
    .get(function (req, res) {
        iamportService.getToken(req, res);
    });


/* 
Provide the `customer_uid` to the path variable `:customer_uid` ( customer_uid = {business_id} + '_' + {card_last_4_digits} ).
Once we call POST /customer/:customer_uid, we can use the `customer_uid` to request payment using the corresponding payment method.
*/
router.route('/customer/:customer_uid')
    .get(function (req, res) {
        // Uses 'customer_uid' to retrieve the payment method
        iamportService.getCustomer(req, res);
    })
    .post(function (req, res) {
        // Creates a customer (single payment method) using the provided 'customer_uid'
        iamportService.createCustomer(req, res);
    })
    .delete(function (req, res) {
        // Uses 'customer_uid' to delete the payment method
        iamportService.deleteCustomer(req, res);
    });

/* 
Use the business_id (formerly restaurant_id) for the `merchant_uid`.
This way, we can retrieve all the transaction history for a specific `merchant_uid` (which is mapped to a specific business).
*/
router.post('/pay/:customer_uid', function (req, res) {
    // Processes a one-time payment with the provided `customer_uid`
    iamportService.pay(req, res);
});

/*
Use the business_id (formerly restaurant_id) for the `merchant_uid`.
This will retrieve all the transaction history for a specific `merchant_uid` (which is mapped to a specific business).
*/
router.get('/history/:merchant_uid', function (req, res) {
    // Retrieve all transaction hisotry for the provided `merchant_uid`
    iamportService.getHistory(req, res);
})


router.route('/payment-hook')
    .post(function (req, res) {
        // This endpoint will be reserved for Iamport to send success/failure result on payment transactions
        iamportService.paymentHook(req, res);
    });

module.exports = router