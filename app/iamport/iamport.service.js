'use strict';

const Iamport = require('iamport');
const moment = require('moment');
const nodemailer = require('nodemailer');
const logger = require('tracer').console({ format: "{{message}}  - {{file}}:{{line}}" });
const mongoDB = require('../db');

const billing_plan_types = {
    "4_WEEK": 4,
    "26_WEEK": 26,
    "52_WEEK": 52
};

const transporter = nodemailer.createTransport({
    "service": 'Gmail',
    "auth": {
        "type": 'OAuth2',
        "user": process.env.FROM_EMAIL_ID,
        "clientId": process.env.GMAIL_CLIENT_ID,
        "clientSecret": process.env.GMAIL_CLIENT_SECRET,
        "refreshToken": process.env.GMAIL_REFRESH_TOKEN,
        "accessToken": process.env.GMAIL_ACCESS_TOKEN
    }
});

const mailOptions = {
    "from": process.env.FROM_EMAIL_ID,
    "to": process.env.TO_EMAIL_IDS,
    "subject": 'Payment Statement',
    "text": `Date: ${new Date()}\nMessage: Testing...`
};

class IamportService {
    constructor() {
        this.iamport = new Iamport({
            impKey: process.env.IAMPORT_APIKEY,
            impSecret: process.env.IAMPORT_SECRET
        });
    }

    /**
     * Triggers checking payment schedules at 6AM everyday.
     */
    _checkScheduleAt6AM() {
        let self = this;
        console.log('Waiting for next 6AM');
        let full_day = 24 * 60 * 60 * 1000;
        let now = new Date();
        let next_morning = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 6, 0, 0, 0);
        // Calculate time until next 6AM
        let time_until = (next_morning.getTime() - now.getTime()) % full_day;
        // Check for scheduled payments at next 6AM
        setTimeout(function () { self._checkScheduledPayments(); }, time_until);
    }

    /**
     * Checks the payment schedules and process them.
     */
    _checkScheduledPayments() {
        transporter.sendMail(mailOptions)
            .then(info => logger.debug('Email sent: ' + info.response))
            .catch(mail_error => logger.error(mail_error))
        // Find all scheduled payments with pending flag for today and before
        let now = new Date();
        mongoDB.getDB().collection('payment-schedule').find(
            {
                "pending": true,
                "scheduled_date": {
                    "$lte": new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
                }
            },
            function (db_error, cursor) {
                cursor.forEach(
                    // Iteration callback
                    function (document) {
                        console.log(document.scheduled_date);
                        // Make the payment
                    },
                    // End callback
                    function (error) {
                        // Do nothing
                    }
                )
            }
        );
        // Schdule payment-schedule check at next 6AM
        this._checkScheduleAt6AM();
    }

    /**
     * Fetches all payment methods ('customer_uid') for the business ('business_id').
     * @param {*} req 
     * @param {*} res 
     */
    getPaymentMethods(req, res) {
        let self = this;
        // Find all payment methods under the business
        mongoDB.getDB().collection('payment-methods').find(
            { "business_id": req.params.business_id },
            function (db_error, cursor) {
                let promises = [];
                let methods = [];
                cursor.forEach(
                    // Iteration callback
                    function (document) {
                        // Create a promise for each I'mport request
                        promises.push(self.iamport.subscribe_customer.get({ "customer_uid": document.customer_uid })
                            .then(iamport_result => {
                                logger.debug(`Successfully fetched payment method (${iamport_result.customer_uid}) from I'mport.`);
                                iamport_result.default_method = document.default_method;
                                methods.push(iamport_result);
                            }).catch(iamport_error => {
                                logger.error(iamport_error);
                                methods.push({
                                    "error": {
                                        "code": iamport_error.code,
                                        "message": iamport_error.message
                                    }
                                })
                            })
                        );
                    },
                    // End callback
                    function (error) {
                        Promise.all(promises)
                            .then(function () {
                                res.send({
                                    "sucecss": true,
                                    "data": methods
                                });
                            })
                            .catch(err => {
                                logger.error(err);
                                res.send({
                                    "success": false,
                                    "message": 'Something went wrong during the end callback of cursor iteration',
                                    "error": {
                                        "code": err.code,
                                        "message": err.message
                                    }
                                });
                            })
                    })
            }
        )
    }

    /**
     * Registers a given payment method with I'mport for the business ('business_id').
     * @param {*} req 
     * @param {*} res 
     */
    createPaymentMethod(req, res) {
        let business_id = req.params.business_id;
        let last_4_digits = req.body.card_number.split('-')[3];
        // Check for I'mport vulnerability
        if (last_4_digits.length !== 4) {
            let msg = `The last 4 digits are not 4 digits long (${last_4_digits}).`;
            logger.error(msg);
            res.send({
                "success": false,
                "error": {
                    "code": 'castr_payment_error'
                },
                "message": msg
            });
            return;
        }
        // Request I'mport service
        this.iamport.subscribe_customer.create({
            // Required
            "customer_uid": `${business_id}_${last_4_digits}`,
            "card_number": req.body.card_number,
            "expiry": req.body.expiry,
            "birth": req.body.birth,
            "pwd_2digit": req.body.pwd_2digit,
            // Optional
            "customer_name": req.body.customer_name,
            "customer_tel": req.body.customer_tel,
            "customer_email": req.body.customer_email,
            "customer_addr": req.body.customer_addr,
            "customer_postcode": req.body.customer_postcode
        })
            .then(iamport_result => {
                logger.debug(`Succesfully registered payment method (${iamport_result.customer_uid}) with I'mport.`);
                // Update this payment method to the business account in castrDB
                mongoDB.getDB().collection('payment-methods').updateOne(
                    {
                        "business_id": business_id,
                        "customer_uid": iamport_result.customer_uid
                    },
                    {
                        "$setOnInsert": {
                            "business_id": business_id,
                            "created_time": new Date()
                        },
                        "$set": {
                            "customer_uid": iamport_result.customer_uid,
                            "default_method": false,
                            "updated_time": new Date()
                        }
                    },
                    { upsert: true }
                );
                res.send({
                    "success": true,
                    "message": `New payment method (${iamport_result.customer_uid}) has been created.`,
                    "data": iamport_result
                });
            }).catch(iamport_error => {
                logger.error(iamport_error);
                res.send({
                    "success": false,
                    "message": 'Something went wrong with I\'mport while registering new payment method.',
                    "error": {
                        "code": iamport_error.code,
                        "message": iamport_error.message
                    }
                });
            });
    }

    /**
     * Removes a given payment method ('customer_uid') from I'mport for the business ('business_id').
     * @param {*} req 
     * @param {*} res 
     */
    deletePaymentMethod(req, res) {
        this.iamport.subscribe_customer.delete({ "customer_uid": req.body.customer_uid })
            .then(iamport_result => {
                let msg = `Payment method (${iamport_result.customer_uid}) has been removed.`
                logger.debug(msg);
                mongoDB.getDB().collection('payment-methods').deleteOne({ "customer_uid": iamport_result.customer_uid });
                res.send({
                    "success": true,
                    "message": msg,
                    "data": iamport_result
                });
            }).catch(iamport_error => {
                logger.error(iamport_error);
                res.send({
                    "success": false,
                    "message": 'Something went wrong with I\'mport while removing the payment method.',
                    "error": {
                        "code": iamport_error.code,
                        "message": iamport_error.message
                    }
                });
            });
    }

    /**
     * Sets the provided payment method ('customer_uid') as the default payment method for the business ('business_id').
     * @param {*} req 
     * @param {*} res 
     */
    setAsDefault(req, res) {
        // Unset the current default method   
        mongoDB.getDB().collection('payment-methods').updateOne(
            {
                "business_id": req.params.business_id,
                "default_method": true
            },
            { "$set": { "default_method": false } },
            // Set the provided method as the new default
            function (unset_db_error, unset_write_result) {
                mongoDB.getDB().collection('payment-methods').updateOne(
                    { "customer_uid": req.params.customer_uid },
                    { "$set": { "default_method": true } },
                    function (set_db_error, set_write_result) {
                        // If no payment method found, return error
                        if (set_write_result.matchedCount === 0) {
                            let msg = `No payment method was found for the given 'customer_uid' (${req.params.customer_uid}).`;
                            logger.error(msg);
                            res.send({
                                "success": false,
                                "error_code": 'castr_payment_error',
                                "message": msg
                            });
                            return;
                        }
                        res.send({
                            "success": true,
                            "message": `Payment method (${req.params.customer_uid}) has been set as default.`,
                            "data": { "customer_uid": req.params.customer_uid }
                        });
                    }
                )
            }
        )
    }

    /**
     * Subscribes the business ('business_id') for recurring payments.
     * @param {*} req 
     * @param {*} res 
     */
    subscribe(req, res) {
        // Validate billing plan
        let billing_plan = req.body.billing_plan;
        if (!billing_plan_types.hasOwnProperty(req.body.billing_plan)) {
            let msg = `'billing_plan' not supported, must provide either: ${Object.keys(billing_plan_types)}.`;
            logger.error(msg);
            res.send({
                "success": false,
                "error": {
                    "code": 'castr_payment_error'
                },
                "message": msg
            });
            return;
        }
        let start = moment().utc();
        let end = moment().utc().add(billing_plan_types[billing_plan], 'week').subtract(1, 'day');
        let data = {
            "name": `Castr subscription ${start.format('M/D')} - ${end.format('M/D')} (${billing_plan})`,
            "charge_num": req.body.charge_num,
            "amount": req.body.amount,
            "vat": req.body.vat
        };
        // Process initial payment
        this.pay(req.params.business_id, data, function (payment_error, payment_result) {
            if (payment_error) {
                res.send({
                    "success": false,
                    "message": 'Something went wrong with I\'mport while charging the initial payment.',
                    "error": {
                        "error_code": payment_error.code,
                        "message": payment_error.message
                    }
                });
                return;
            }
            // Schedule next payment using billing_plan
            res.send('ok');
        });
    }

    /**
     * Processes a one-time payment using the default payment method set for the business ('business_id').
     * @param {*} business_id 
     * @param {*} data
     * @param {*} callback 
     */
    pay(business_id, data, callback) {
        let self = this;
        // Fetch the default payment method
        mongoDB.getDB().collection('payment-methods').findOne(
            {
                "business_id": business_id,
                "default_method": true
            },
            function (db_error, default_method) {
                // If no default method was found, return error
                if (default_method === null) {
                    let msg = `Could not find a default payment method for the business (${business_id}).`;
                    logger.error(msg);
                    res.send({
                        "success": false,
                        "error": {
                            "code": 'castr_payment_error'
                        },
                        "message": msg
                    });
                    return;
                }
                // Request I'mport for payment
                self.iamport.subscribe.again({
                    "merchant_uid": `${business_id}_ch${data.charge_num}`,
                    "customer_uid": default_method.customer_uid,
                    "name": data.name,
                    "amount": data.amount,
                    "vat": data.vat,
                    // "custom_data": JSON.stringify({
                    //     "customer_uid": data.customer_uid,
                    //     "business_id": data.business_id,
                    //     "billing_plan": data.billing_plan,
                    //     "charge_num": data.charge_num
                    // })
                })
                    .then(iamport_result => {
                        logger.debug(`Successfully made the payment (${iamport_result.merchant_uid}).`);
                        callback(null, iamport_result);
                    }).catch(iamport_error => {
                        logger.error(iamport_error);
                        callback(iamport_error, null);
                    });
            }
        )
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

    /* getHistory(req, res) {
        let self = this;
        new Promise()
        let recursiveFetch = function (customer_uid, data, page) {
            self.iamport.subscribe_customer.getPayments({
                "customer_uid": customer_uid,
                "page": page
            })
                .then(iamport_result => {
                    logger.debug(iamport_result);
                    if (iamport_result.next !== 0) {
                        recursiveFetch(customer_uid, data.concat(iamport_result.list), iamport_result.next);
                    } else {
                        data.concat(iamport_result.list);
                    }
                }).catch(iamport_error => {
                    logger.error(iamport_error);
                });
        }
        // Find all payment methods under the business
        mongoDB.getDB().collection('payment-methods').find(
            { "business_id": req.params.business_id },
            function (db_error, cursor) {
                let promises = [];
                let methods = [];
                cursor.forEach(
                    // Iteration callback
                    function (document) {
                        // Create a promise for each I'mport request




                         promises.push(self.iamport.subscribe_customer.get({ "customer_uid": document.customer_uid })
                            .then(iamport_result => {
                                logger.debug(`Successfully fetched payment method (${iamport_result.customer_uid}) from I'mport.`);
                                iamport_result.default_method = document.default_method;
                                methods.push(iamport_result);
                            }).catch(iamport_error => {
                                logger.error(iamport_error);
                                methods.push({
                                    "error": {
                                        "code": iamport_error.code,
                                        "message": iamport_error.message
                                    }
                                })
                            })
                        ); 
                    },
                    // End callback
                    function (error) {
                        Promise.all(promises)
                            .then(function () {
                                res.send({
                                    "sucecss": true,
                                    "data": methods
                                });
                            })
                            .catch(err => {
                                logger.error(err);
                                res.send({
                                    "success": false,
                                    "message": 'Something went wrong during the end callback of cursor iteration',
                                    "error": {
                                        "code": err.code,
                                        "message": err.message
                                    }
                                });
                            })
                    })
            }
        )
    } */

    paymentHook(req, res) {
        switch (req.body.status) {
            case 'ready':
                // This shouldn't happen, will it?
                let email = {
                    "from": process.env.FROM_EMAIL_ID,
                    "to": process.env.TO_EMAIL_IDS,
                    "subject": 'Payment Ready',
                    "text": JSON.stringify(req.body)
                };
                transporter.sendMail(email)
                    .then(info => logger.debug('Email sent: ' + info.response))
                    .catch(mail_error => logger.error(mail_error));
                break;
            case 'paid':
                // Fetch the transaction
                this.iamport.payment.getByImpUid({ "imp_uid": req.body.imp_uid })
                    .then(iamport_result => {
                        let email = {
                            "from": process.env.FROM_EMAIL_ID,
                            "to": process.env.TO_EMAIL_IDS,
                            "subject": 'Payment Ready',
                            "text": JSON.stringify(iamport_result)
                        };
                        transporter.sendMail(email)
                            .then(info => logger.debug('Email sent: ' + info.response))
                            .catch(mail_error => logger.error(mail_error));
                        let response = iamport_result.response;
                        // Insert to db
                        mongoDB.getDB().collection('payment-transactions').insertOne(
                            {
                                "imp_uid": response.imp_uid,
                                "merchant_uid": response.merchant_uid,
                                "name": response.name,
                                "amount": response.amount,
                                "currency": response.currency,
                                "pay_method": response.pay_method,
                                "card_name": response.card_name,
                                "status": 'paid',
                                "receipt_url": response.receipt_url,
                                "time_paid": new Date(response.paid_at)
                            }
                        );
                    }).catch(iamport_error => {
                        logger.error(iamport_error);
                    });
                break;
            case 'failed':
                logger.error('I\'mport payment has failed for some reason.');
                // Fetch the transaction
                this.iamport.payment.getByImpUid({ "imp_uid": req.body.imp_uid })
                    .then(iamport_result => {
                        let email = {
                            "from": process.env.FROM_EMAIL_ID,
                            "to": process.env.TO_EMAIL_IDS,
                            "subject": 'Payment Failed',
                            "text": JSON.stringify(iamport_result)
                        };
                        transporter.sendMail(email)
                            .then(info => logger.debug('Email sent: ' + info.response))
                            .catch(mail_error => logger.error(mail_error));
                    }).catch(iamport_error => {
                        logger.error(iamport_error);
                    });
                break;
            case 'cancelled':
                // Update database as refunded
                break;
            default:
                logger.debug(req.body);
        }
    }
}

module.exports = new IamportService();