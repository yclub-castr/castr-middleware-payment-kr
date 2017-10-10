'use strict';

const Iamport = require('iamport');
const moment = require('moment-timezone');
const nodemailer = require('nodemailer');
const mongoDB = require('../db');
const logger = require('tracer').console({
    format: "[{{timestamp}}] <{{title}}> {{message}} - ({{file}}:{{line}})",
    dateformat: "mmm. d | HH:MM:ss.L"
});

const timezone = 'ASIA/SEOUL';

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
     * Triggers checking payment schedules at 6 am everyday.
     */
    _checkScheduleAt6AM() {
        let self = this;
        let full_day = 24 * 60 * 60 * 1000;
        let utc_now = moment.tz('UTC');
        let local_next_morning = moment(utc_now).add(1, 'day').tz(timezone).hour(6).minute(0).second(0).millisecond(0);
        // Calculate time until next 6 am
        let time_until = local_next_morning.diff(utc_now) % full_day;
        // Check for scheduled payments at next 6 am
        setTimeout(function () { self._checkScheduledPayments(); }, time_until);
        logger.debug(`Next schedule check scheduled at ${(time_until / 3600000).toFixed(2)} hours later.`);
    }

    /**
     * Checks the payment schedules and process them.
     * This runs daily at 6 am.
     */
    _checkScheduledPayments() {
        logger.debug(`Checking for payments scheduled on ${moment.tz(timezone).format('MMM DD YYYY')}.`);
        // Find all scheduled payments with pending flag for today and before
        mongoDB.getDB().collection('payment-schedule').find(
            {
                "pending": true,
                "scheduled_date": {
                    "$lte": moment.tz(timezone).hour(0).minute(0).second(0).millisecond(0).toDate()
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
                                    "message": null,
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
                "message": msg,
                "error": {
                    "code": 'castr_payment_error'
                }
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
                                "message": msg,
                                "error": {
                                    "code": 'castr_payment_error'
                                }
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
                "message": msg,
                "error": {
                    "code": 'castr_payment_error'
                }
            });
            return;
        }
        let start = moment().utc();
        let end = moment().utc().add(billing_plan_types[billing_plan], 'week').subtract(1, 'day');
        let data = {
            "name": `Castr subscription ${start.format('M/D')} - ${end.format('M/D')} (${billing_plan})`,
            "billing_plan": billing_plan,
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
            res.send({
                "success": true,
                "message": `Initial payment of (${payment_result.amount} ${payment_result.currency}) was successfully charged to the business (${req.params.business_id}).`,
                "data": payment_result
            });
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
                        "message": msg,
                        "error": {
                            "code": 'castr_payment_error'
                        }
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
                    "custom_data": JSON.stringify({
                        "business_id": business_id,
                        "customer_uid": default_method.customer_uid,
                        "billing_plan": data.billing_plan,
                        "charge_num": data.charge_num
                    })
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

    getHistory(req, res) {
        let self = this;
        // Find all payment transactions from the business
        mongoDB.getDB().collection('payment-transactions').find(
            { "business_id": req.params.business_id },
            function (db_error, cursor) {
                let methods = [];
                cursor.forEach(
                    // Iteration callback
                    function (document) {
                        methods.push(document);
                    },
                    // End callback
                    function (error) {
                        res.send({
                            "sucecss": true,
                            "message": null,
                            "data": methods
                        });
                    })
            }
        )
    }

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
                        let custom_data = JSON.parse(iamport_result.custom_data);
                        let time_paid = moment(iamport_result.paid_at * 1000).tz(timezone);
                        // Insert payment result to db
                        mongoDB.getDB().collection('payment-transactions').insertOne(
                            {
                                "business_id": custom_data.business_id,
                                "imp_uid": iamport_result.imp_uid,
                                "merchant_uid": iamport_result.merchant_uid,
                                "name": iamport_result.name,
                                "amount": iamport_result.amount,
                                "currency": iamport_result.currency,
                                "customer_uid": custom_data.customer_uid,
                                "pay_method": iamport_result.pay_method,
                                "card_name": iamport_result.card_name,
                                "status": 'paid',
                                "receipt_url": iamport_result.receipt_url,
                                "time_paid": time_paid.toDate()
                            }
                        );
                        // Calculate next pay date
                        let next_pay_date = moment(time_paid)
                            .add(billing_plan_types[custom_data.billing_plan], 'week')
                            .hour(0)
                            .minute(0)
                            .second(0)
                            .millisecond(0);
                        // Insert to payment-schedule collection
                        mongoDB.getDB().collection('payment-schedule').insertOne(
                            {
                                "business_id": custom_data.business_id,
                                "schedule": next_pay_date.toDate(),
                                "charge_num": parseInt(custom_data.charge_num) + 1,
                                "amount": iamport_result.amount,
                                "billing_plan": custom_data.billing_plan,
                                "pending": true
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
                // Disable service
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