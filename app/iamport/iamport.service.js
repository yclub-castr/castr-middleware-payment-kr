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
        let getMethods =  this._getMethods;
        mongoDB.getDB().collection('payments').find(
            { "business_id": req.params.business_id },
            function (err, cursor) {
                console.log(cursor);
                let methods = [];
                getMethods(cursor, methods);
            }
        )
    }

    _getMethods(cursor, methods) {
        let getMethods =  this._getMethods;
        let getMethod = this._getMethod;
        cursor.hasNext(function (err, result) {
            cursor.next(function (err, result) {
                getMethod(result.customer_uid, methods);
                getMethods(cursor, methods);
            })
        });
    }

    _getMethod(customer_uid, methods){
        this.iamport.subscribe_customer.get({ "customer_uid": customer_uid })
        .then(result => {
            console.log(result);
            methods.add(result);
            // res.send(result);
        }).catch(err => {
            console.log(err);
            methods.add(err);
            // res.send({
            //     "error_code": err.code,
            //     "message": err.message
            // });
        });
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
        }).then(result => {
            console.log(result);
            mongoDB.getDB().collection('payments').updateOne(
                {
                    "business_id": business_id,
                    "customer_uid": result.customer_uid
                },
                {
                    "$setOnInsert": {
                        "business_id": business_id,
                        "created_time": Date.now()
                    },
                    "$set": {
                        "customer_uid": result.customer_uid,
                        "updated_time": Date.now()
                    }
                },
                { upsert: true }
            );
            // Update this payment method to the business account in castrDB
            // Find the document by `business_id` ( result.customer_uid.split('_')[0] )
            // Also include `last_4_digits` ( result.customer_uid.split('_')[1] )
            res.send(result);
        }).catch(err => {
            console.log(err);
            res.send({
                "error_code": err.code,
                "message": err.message
            });
        });
    }

    deletePaymentMethod(req, res) {
        this.iamport.subscribe_customer.delete({ "customer_uid": req.body.customer_uid })
            .then(result => {
                console.log(result);
                res.send(result);
            }).catch(err => {
                console.log(err);
                res.send({
                    "error_code": err.code,
                    "message": err.message
                });
            });
    }

    subscribe(req, res) {
        try {
            let business_id = req.params.customer_uid.split('_')[0];
            let billing_plan = req.body['billing_plan'];
            let charge_num = req.body['charge_num'];
            // Validate billing plan
            if (!billing_plan_types.hasOwnProperty(billing_plan)) {
                throw new Error('billing_plan not supported, must provide either: ' + Object.keys(billing_plan_types));
            }
            let start = moment().utc();
            let end = moment().utc().add(billing_plan_types[billing_plan], 'week').subtract(1, 'day');
            // Process initial payment
            this.iamport.subscribe.again({
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
                .then(result => {
                    console.log(result);
                    // Schedule next payment
                    this.schedule(res, result);
                }).catch(err => {
                    console.log(err);
                    res.send({
                        "payment": {
                            "error_code": err.code,
                            "message": err.message
                        },
                        "schedule": null
                    });
                });
        } catch (error) {
            console.log(error);
            res.send(error);
        }
    }

    schedule(res, result) {
        let custom_data = JSON.parse(result.custom_data);
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
        logger.debug(result);
        this.iamport.subscribe.schedule({
            "customer_uid": customer_uid,
            "schedules": [{
                "merchant_uid": `${business_id}_ch${++charge_num}`,
                "schedule_at": next_cycle_start.unix(),
                "amount": result['amount'],
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
                    "payment": result,
                    "schedule": schedule_result
                });
            }).catch(err => {
                logger.error(err);
                res.send({
                    "payment": result,
                    "schedule": {
                        "error_code": err.code,
                        "message": err.message
                    }
                });
            });
    }

    unsubscribe(req, res) {
        this.iamport.subscribe.unschedule({
            "customer_uid": req.params.customer_uid,
            "merchant_uid": null
        })
            .then(result => {
                console.log(result);
                res.send(result);
            })
            .catch(err => {
                console.log(err);
                res.send({
                    "error_code": err.code,
                    "message": err.message
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
                    "error_code": err.code,
                    "message": err.message
                });
            });
    }

    getHistory(req, res, data, page) {
        this.iamport.subscribe_customer.getPayments({
            "customer_uid": req.params.customer_uid,
            "page": page
        })
            .then(result => {
                console.log(result);
                if (result['next'] !== 0) {
                    this.getHistory(req, res, data.concat(result.list), result['next']);
                } else {
                    res.send(data.concat(result.list));
                }
            }).catch(err => {
                console.log(err);
                res.send({
                    "error_code": err.code,
                    "message": err.message
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
                    .then(result => {
                        // Insert to db
                        mongoDB.getDB().collection('transactions').updateOne(
                            {
                                "imp_uid": result.response.imp_uid,
                                "merchant_uid": result.response.merchant_uid
                            },
                            result.response,
                            { "upsert": true }
                        );
                    }).catch(err => {
                        console.log(err);
                        const error = ({
                            "error_code": err.code,
                            "message": err.message
                        });
                        res.send(error);
                    });
                break;
            case 'failed':
                // Fetch the transaction
                this.iamport.payment.getByImpUid({ "imp_uid": req.body['imp_uid'] })
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
                                "imp_uid": result.response.imp_uid,
                                "merchant_uid": result.response.merchant_uid
                            },
                            result.response,
                            { "upsert": true }
                        );
                        // Retry

                        res.send(result);
                    }).catch(err => {
                        error({
                            "error_code": err.code,
                            "message": err.message
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