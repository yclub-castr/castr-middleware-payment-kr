const Iamport = require('iamport');
const moment = require('moment');
const logger = require('tracer').console({ format: "{{message}}  - {{file}}:{{line}}" });
const mongoDB = require('../db');

const billing_plan_types = {
    "4_WEEK": 4,
    "26_WEEK": 26,
    "52_WEEK": 52
}

class IamportService {
    constructor() {
        this.iamport = new Iamport({
            impKey: process.env.IAMPORT_APIKEY,
            impSecret: process.env.IAMPORT_SECRET
        });
    }

    getPaymentMethods(req, res) {
        let self = this;
        mongoDB.getDB().collection('payments').find(
            { "business_id": req.params.business_id },
            function (db_error, cursor) {
                let promises = [];
                let methods = [];
                cursor.forEach(
                    // iteration callback
                    function (document) {
                        promises.push(self.iamport.subscribe_customer.get({ "customer_uid": document.customer_uid })
                            .then(iamport_result => {
                                logger.debug(iamport_result);
                                methods.push(iamport_result);
                            }).catch(iamport_error => {
                                logger.debug(iamport_error);
                                methods.push(iamport_error);
                            })
                        );
                    },
                    // end callback
                    function (error) {
                        Promise.all(promises)
                            .then(function () {
                                logger.debug(methods);
                                res.send(methods);
                            })
                            .catch(err => { })
                    })
            }
        )
    }

    /**
     * Creates a payment method for the user. The 'customer_uid' must be a uniquely identifiable id for each payment method.
     * 
     * @param {*} req 
     * @param {*} res 
     */
    createPaymentMethod(req, res) {
        let business_id = req.params.business_id;
        let last_4_digits = req.body['card_number'].split('-')[3];
        this.iamport.subscribe_customer.create({
            // Required
            "customer_uid": `${business_id}_${last_4_digits}`,
            "card_number": req.body['card_number'],
            "expiry": req.body['expiry'],
            "birth": req.body['birth'],
            "pwd_2digit": req.body['pwd_2digit'],
            // Optional
            "customer_name": req.body['customer_name'],
            "customer_tel": req.body['customer_tel'],
            "customer_email": req.body['customer_email'],
            "customer_addr": req.body['customer_addr'],
            "customer_postcode": req.body['customer_postcode']
        })
            .then(iamport_result => {
                logger.debug(iamport_result);
                // Update this payment method to the business account in castrDB
                mongoDB.getDB().collection('payments').updateOne(
                    {
                        "business_id": business_id,
                        "customer_uid": iamport_result.customer_uid
                    },
                    {
                        "$setOnInsert": {
                            "business_id": business_id,
                            "created_time": Date.now()
                        },
                        "$set": {
                            "customer_uid": iamport_result.customer_uid,
                            "default_method": false,
                            "updated_time": Date.now()
                        }
                    },
                    { upsert: true }
                );
                res.send(iamport_result);
            }).catch(iamport_error => {
                logger.debug(iamport_error);
                res.send({
                    "error_code": iamport_error.code,
                    "message": iamport_error.message
                });
            });
    }

    deletePaymentMethod(req, res) {
        this.iamport.subscribe_customer.delete({ "customer_uid": req.body.customer_uid })
            .then(iamport_result => {
                logger.debug(iamport_result);
                mongoDB.getDB().collection('payments').deleteOne({ "customer_uid": iamport_result.customer_uid });
                res.send(iamport_result);
            }).catch(iamport_error => {
                logger.debug(iamport_error);
                res.send({
                    "error_code": iamport_error.code,
                    "message": iamport_error.message
                });
            });
    }

    subscribe(req, res) {
        try {
            let self = this;
            let business_id = req.params.business_id;
            let billing_plan = req.body['billing_plan'];
            let charge_num = req.body['charge_num'];
            // Validate billing plan
            if (!billing_plan_types.hasOwnProperty(billing_plan)) {
                throw new Error('billing_plan not supported, must provide either: ' + Object.keys(billing_plan_types));
            }
            let start = moment().utc();
            let end = moment().utc().add(billing_plan_types[billing_plan], 'week').subtract(1, 'day');
            // Get 'customer_uid' for the default payment method
            mongoDB.getDB().collection('payments').find(
                {
                    "business_id": business_id,
                    "default_method": true
                },
                function (db_error, cursor) {
                    // Count found payment methods
                    cursor.count(function (err, count) {
                        if (count === 0) {
                            throw new Error(`Could not find a default payment method for the business (${business_id}).`);
                        }
                        // Process initial payment
                        self.iamport.subscribe.again({
                            "customer_uid": req.params.customer_uid,
                            "merchant_uid": `${business_id}_ch${charge_num}`,
                            "amount": req.body['amount'],
                            "vat": req.body['vat'],
                            "name": `Castr subscription ${start.format('M/D')} - ${end.format('M/D')} (${billing_plan})`,
                            "custom_data": JSON.stringify({
                                "customer_uid": req.params.customer_uid,
                                "business_id": business_id,
                                "billing_plan": billing_plan,
                                "charge_num": charge_num
                            })
                        })
                            .then(iamport_result => {
                                logger.debug(iamport_result);
                                // Schedule next payment
                                self.schedule(res, iamport_result);
                            }).catch(iamport_error => {
                                logger.error(iamport_error);
                                res.send({
                                    "payment": {
                                        "error_code": iamport_error.code,
                                        "message": iamport_error.message
                                    },
                                    "schedule": null
                                });
                            });
                    })
                }
            )
        } catch (error) {
            console.log(error);
            res.send(error);
        }
    }

    schedule(res, iamport_result) {
        let custom_data = JSON.parse(iamport_result.custom_data);
        let customer_uid = custom_data['customer_uid'];
        let business_id = custom_data['business_id'];
        let charge_num = custom_data['charge_num'];
        let billing_plan = custom_data['billing_plan'];
        // Create next billing date
        let today = new Date();
        today.setHours(0, 0, 0);
        let next_cycle_start = moment.utc(today).add(billing_plan_types[billing_plan], 'week');
        let next_cycle_end = moment.utc(today).add(billing_plan_types[billing_plan] * 2, 'week').subtract(1, 'day');
        // TODO
        logger.debug(iamport_result);
        this.iamport.subscribe.schedule({
            "customer_uid": customer_uid,
            "schedules": [{
                "merchant_uid": `${business_id}_ch${++charge_num}`,
                "schedule_at": next_cycle_start.unix(),
                "amount": iamport_result['amount'],
                "name": `Castr subscription ${next_cycle_start.format('M/D')} - ${next_cycle_end.format('M/D')} (${billing_plan})`,
                "custom_data": JSON.stringify({
                    "customer_uid": customer_uid,
                    "business_id": business_id,
                    "billing_plan": billing_plan,
                    "charge_num": charge_num
                })
            }]
        })
            .then(schedule_result => {
                console.log(schedule_result);
                // Schedule next payment
                res.send({
                    "payment": iamport_result,
                    "schedule": schedule_result
                });
            }).catch(iamport_error => {
                logger.error(iamport_error);
                res.send({
                    "payment": iamport_result,
                    "schedule": {
                        "error_code": iamport_error.code,
                        "message": iamport_error.message
                    }
                });
            });
    }

    unsubscribe(req, res) {
        this.iamport.subscribe.unschedule({
            "customer_uid": req.params.customer_uid,
            "merchant_uid": null
        })
            .then(iamport_result => {
                console.log(iamport_result);
                res.send(iamport_result);
            })
            .catch(iamport_errorerr => {
                console.log(iamport_error);
                res.send({
                    "error_code": iamport_error.code,
                    "message": iamport_error.message
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
            .then(iamport_result => {
                console.log(iamport_result);
                res.send(iamport_result);
            })
            .catch(iamport_error => {
                console.log(iamport_error);
                res.send({
                    "error_code": iamport_error.code,
                    "message": iamport_error.message
                });
            });
    }

    getHistory(req, res, data, page) {
        this.iamport.subscribe_customer.getPayments({
            "customer_uid": req.params.customer_uid,
            "page": page
        })
            .then(iamport_result => {
                console.log(iamport_result);
                if (iamport_result['next'] !== 0) {
                    this.getHistory(req, res, data.concat(iamport_result.list), iamport_result['next']);
                } else {
                    res.send(data.concat(iamport_result.list));
                }
            }).catch(iamport_error => {
                console.log(iamport_error);
                res.send({
                    "error_code": iamport_error.code,
                    "message": iamport_error.message
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
                this.iamport.payment.getByImpUid({ "imp_uid": req.body['imp_uid'] })
                    .then(iamport_result => {
                        // Insert to db
                        mongoDB.getDB().collection('transactions').updateOne(
                            {
                                "imp_uid": iamport_result.response.imp_uid,
                                "merchant_uid": iamport_result.response.merchant_uid
                            },
                            iamport_result.response,
                            { "upsert": true }
                        );
                    }).catch(iamport_errorerr => {
                        logger.error(iamport_error);
                        const iamport_error = ({
                            "error_code": iamport_error.code,
                            "message": iamport_error.message
                        });
                        res.send(error);
                    });
                break;
            case 'failed':
                // Fetch the transaction
                this.iamport.payment.getByImpUid({ "imp_uid": req.body['imp_uid'] })
                    .then(iamport_result => {
                        console.log(iamport_result);
                        if (iamport_result.response.custom_data.fail_count === 3) {
                            // If failed 3rd time, pause service and retry when different payment method is provided
                        }
                        // Increment failure count
                        iamport_result.response.custom_data.fail_count += 1
                        // Insert to db
                        mongoDB.getDB().collection('transactions').updateOne(
                            {
                                "imp_uid": iamport_result.response.imp_uid,
                                "merchant_uid": iamport_result.response.merchant_uid
                            },
                            iamport_result.response,
                            { "upsert": true }
                        );
                        // Retry

                        res.send(iamport_result);
                    }).catch(iamport_error => {
                        logger.error({
                            "error_code": iamport_error.code,
                            "message": iamport_error.message
                        });
                        res.send(iamport_error);
                    });
                break;
            case 'cancelled':
                // Update database as refunded
                break;
            default:
                logger.log(req.body);
                res.send(req.body);
        }
    }
}

module.exports = new IamportService();