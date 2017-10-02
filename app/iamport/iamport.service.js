const Iamport = require('iamport')

class IamportService {
    constructor() {
        this.iamport = new Iamport({
            impKey: process.env.IAMPORT_APIKEY,
            impSecret: process.env.IAMPORT_SECRET
        });
    }

    /**
     * Creates a payment method for the user. The 'customer_uid' must be a uniquely identifiable id for each payment method.
     * 
     * @param {*} req 
     * @param {*} res 
     */
    createCustomer(req, res) {
        this.iamport.subscribe_customer.create({
            // Required
            // 'customer_uid' must be provided as a unique identifier for this payment method 
            'customer_uid': req.params.customer_uid,
            'card_number': req.body['card_number'],
            'expiry': req.body['expiry'],
            'birth': req.body['birth'],
            'pwd_2digit': req.body['pwd_2digit'],
            // Optional
            'customer_name': req.body['customer_name'],
            'customer_tel': req.body['customer_tel'],
            'customer_email': req.body['customer_email'],
            'customer_addr': req.body['customer_addr'],
            'customer_postcode': req.body['customer_postcode']
        }).then(result => {
            console.log(result);
            // Update this payment method to the business account in castrDB
            // Find the document by `business_id` ( result.customer_uid.split('_')[0] )
            // Also include `last_4_digits` ( result.customer_uid.split('_')[1] )
            res.send(result);
        }).catch(err => {
            console.log(err);
            res.send({
                'error_code': err.code,
                'message': err.message
            });
        });
    }

    getCustomer(req, res) {
        this.iamport.subscribe_customer.get({ 'customer_uid': req.params.customer_uid })
            .then(result => {
                console.log(result);
                res.send(result);
            }).catch(err => {
                console.log(err);
                res.send({
                    'error_code': err.code,
                    'message': err.message
                });
            });
    }

    deleteCustomer(req, res) {
        this.iamport.subscribe_customer.delete({ 'customer_uid': req.params.customer_uid })
            .then(result => {
                console.log(result);
                res.send(result);
            }).catch(err => {
                console.log(err);
                res.send({
                    'error_code': err.code,
                    'message': err.message
                });
            });
    }

    pay(req, res) {
        this.iamport.subscribe.again({
            "customer_uid": req.params.customer_uid,
            "merchant_uid": req.body['merchant_uid'],
            "amount": req.body['amount'],
            "vat": req.body['vat'],
            "name": req.body['name']
        })
            .then(result => {
                console.log(result);
                res.send(result);
            }).catch(err => {
                console.log(err);
                res.send({
                    'error_code': err.code,
                    'message': err.message
                });
            });
    }

    getHistory(req, res) {
        this.iamport.subscribe_customer.getPayments({
            'customer_uid': req.params.customer_uid,
            page: 1
        })
            .then(result => {
                console.log(result);
                // Store the result to DB
                res.send(result);
            }).catch(err => {
                console.log(err);
                res.send({
                    'error_code': err.code,
                    'message': err.message
                });
            });
    }

    paymentHook(req, res) {
        switch (req.body['status']) {
            case 'ready':
                // This shouldn't happen
                break;
            case 'paid':
                // Fetch the transaction
                this.iamport.payment.getByImpUid({ 'imp_uid': req.body['imp_uid'] })
                    .then(result => {
                        // Insert to db
                        mongoDB.getDB().collection('transactions').updateOne(
                            {
                                'imp_uid': result.response.imp_uid,
                                'merchant_uid': result.response.merchant_uid
                            },
                            result.response,
                            { 'upsert': true }
                        );
                    }).catch(err => {
                        console.log(err);
                        const error = ({
                            'error_code': err.code,
                            'message': err.message
                        });
                        res.send(error);
                    });
                break;
            case 'failed':
                // Fetch the transaction
                this.iamport.payment.getByImpUid({ 'imp_uid': req.body['imp_uid'] })
                    .then(result => {
                        console.log(result);
                        if (result.response.custom_data.fail_count === 3) {
                            // If failed 3rd time, pause service and retry when different payment method is provided
                        }
                        // Increment failure count
                        result.response.custom_data.fail_count += 1
                        // Insert to db
                        mongoDB.getDB().collection('transactions').updateOne(
                            {
                                'imp_uid': result.response.imp_uid,
                                'merchant_uid': result.response.merchant_uid
                            },
                            result.response,
                            { 'upsert': true }
                        );
                        // Retry

                        res.send(result);
                    }).catch(err => {
                        error({
                            'error_code': err.code,
                            'message': err.message
                        });
                        res.send(err);
                    });
                break;
            case 'cancelled':
                // Update database as refunded
                break;
            default:
                console.log(req.body);
                res.send(req.body);
        }
    }
}

module.exports = new IamportService();