// app/iamport/iamport.service.js

'use strict';

const mongoDB = require('../db');
const logger = require('../utils').logger();
const moment = require('../utils').moment();
const nodemailer = require('../utils').nodemailer();
const Iamport = require('iamport');

const timezone = 'ASIA/SEOUL';

const billing_plan_types = {
    '4_WEEK': 4,
    '26_WEEK': 26,
    '52_WEEK': 52,
};

class IamportService {
    /**
     * I'mport service class constructor.
     */
    constructor() {
        this.iamport = new Iamport({
            impKey: process.env.IAMPORT_APIKEY,
            impSecret: process.env.IAMPORT_SECRET,
        });
    }

    /**
     * Triggers checking payment schedules at 6 am everyday (local time).
     */
    checkScheduleAt6AM() {
        const full_day = 24 * 60 * 60 * 1000;
        const utc_now = moment.tz('UTC');
        const local_next_morning = moment(utc_now).add(1, 'day').tz(timezone).hour(6).minute(0).second(0).millisecond(0);
        // Calculate time until next 6 am
        const time_until = local_next_morning.diff(utc_now) % full_day;
        // Check for scheduled payments at next 6 am
        const callback = function () {
            this._checkScheduledPayments();
        };
        setTimeout(callback.bind(this), time_until);
        logger.debug(`Next schedule check scheduled at ${(time_until / 3600000).toFixed(2)} hours later.`);
    }

    /**
     * Checks the payment schedules and process them.
     * This runs daily at 6 am (local time).
     */
    _checkScheduledPayments() {
        logger.debug(`Checking for payments scheduled on ${moment.tz(timezone).format('ddd, MMM DD, YYYY')}.`);
        // Result arrays
        const promises = [];
        const successes = [];
        const failures = [];
        // Find all scheduled payments with PENDING status for today and before
        mongoDB.getDB().collection('payment-schedule').find(
            {
                status: 'PENDING',
                schedule: { $lte: moment.tz(timezone).hour(0).minute(0).second(0).millisecond(0).toDate() },
            },
            (db_error, cursor) => {
                cursor.forEach(
                    // Iteration callback
                    (document) => {
                        const schedule_params = {
                            business_id: document.business_id,
                            merchant_uid: document.merchant_uid,
                            type: 'SCHEDULED',
                            billing_plan: document.billing_plan,
                            pay_date: document.schedule,
                            amount: document.amount,
                            vat: document.vat,
                        };
                        // Make the payment
                        promises.push(this.pay(schedule_params)
                            .then((result) => {
                                successes.push(`\n - ${result.data.merchant_uid}: ${result.data.amount} ${result.data.currency}`);
                            })
                            .catch((error) => {
                                failures.push(`\n - ${error.params.merchant_uid}: ${error.params.amount}`);
                            }));
                    },
                    // End callback
                    (end) => {
                        Promise.all(promises)
                            .then(() => {
                                logger.debug(`Scheduled payments requested (${successes.length}/${promises.length}):${successes}`);
                                logger.error(`Scheduled payment requests failed (${failures.length}/${promises.length}):${failures}`);
                            })
                            .catch((err) => {
                                // This shouldn't happen
                                logger.error(err);
                            });
                    }
                );
            }
        );
        // Schdule payment-schedule check at next 6AM
        this.checkScheduleAt6AM();
    }

    /**
     * Fetches all payment methods ('customer_uid') for the business ('business_id').
     * @param {*} req 
     * @param {*} res 
     */
    getPaymentMethods(req, res) {
        // Result arrays
        const promises = [];
        const methods = [];
        // Define iteration callback function
        const iteration_callback = function (document) {
            // Create a promise for each I'mport request
            const params = { customer_uid: document.customer_uid };
            promises.push(this.iamport.subscribe_customer.get(params)
                .then((iamport_result) => {
                    logger.debug(`Successfully fetched payment method (${iamport_result.customer_uid}) from I'mport.`);
                    iamport_result.default_method = document.default_method;
                    methods.push(iamport_result);
                })
                .catch((iamport_error) => {
                    const error = {
                        message: `Failed to fetch payment method (${params.customer_uid}) from I'mport.`,
                        params: params,
                        error: {
                            code: iamport_error.code,
                            message: iamport_error.message,
                        },
                    };
                    logger.error(error);
                    methods.push(error);
                }));
        };
        const end_callback = function (end) {
            Promise.all(promises)
                .then(() => {
                    res.send({
                        sucecss: true,
                        message: `Successfully fetched ${promises.length} payment methods.`,
                        data: methods,
                    });
                })
                .catch((err) => {
                    // Should not happen
                    const error = {
                        message: 'Something went wrong during the end callback of cursor iteration',
                        error: {
                            code: err.code,
                            message: err.message,
                        },
                    };
                    logger.error(error);
                    error.success = false;
                    res.send();
                });
        };
        // Find all payment methods under the business
        mongoDB.getDB().collection('payment-methods').find(
            { business_id: req.params.business_id },
            (db_error, cursor) => {
                cursor.forEach(
                    // Iteration callback
                    iteration_callback.bind(this),
                    // End callback
                    end_callback
                );
            }
        );
    }

    /**
     * Registers a given payment method with I'mport for the business ('business_id').
     * @param {*} req
     * @param {*} res
     */
    createPaymentMethod(req, res) {
        const business_id = req.params.business_id;
        const last_4_digits = req.body.card_number.split('-')[3];
        // Check for I'mport vulnerability
        if (last_4_digits.length !== 4) {
            const msg = `The last 4 digits are not 4 digits long (${last_4_digits}).`;
            logger.error(msg);
            res.send({
                success: false,
                message: msg,
                error: {
                    code: 'castr_payment_error',
                    message: msg,
                },
            });
            return;
        }
        // Request I'mport service
        const customer_uid = `${business_id}_${last_4_digits}`;
        this.iamport.subscribe_customer.create({
            // Required
            customer_uid: customer_uid,
            card_number: req.body.card_number,
            expiry: req.body.expiry,
            birth: req.body.birth,
            pwd_2digit: req.body.pwd_2digit,
            // Optional
            customer_name: req.body.customer_name,
            customer_tel: req.body.customer_tel,
            customer_email: req.body.customer_email,
            customer_addr: req.body.customer_addr,
            customer_postcode: req.body.customer_postcode,
        })
            .then((iamport_result) => {
                logger.debug(`Succesfully registered payment method (${iamport_result.customer_uid}) with I'mport.`);
                // Update this payment method to the business account in castrDB
                mongoDB.getDB().collection('payment-methods').updateOne(
                    {
                        business_id: business_id,
                        customer_uid: iamport_result.customer_uid,
                    },
                    {
                        $setOnInsert: {
                            business_id: business_id,
                            created_time: new Date(),
                        },
                        $set: {
                            customer_uid: iamport_result.customer_uid,
                            default_method: false,
                            updated_time: new Date(),
                        },
                    },
                    { upsert: true }
                );
                res.send({
                    success: true,
                    message: `New payment method (${iamport_result.customer_uid}) has been created.`,
                    data: iamport_result,
                });
            }).catch((iamport_error) => {
                const error = {
                    message: 'Something went wrong with I\'mport while registering new payment method.',
                    params: {
                        business_id: business_id,
                        customer_uid: customer_uid,
                    },
                    error: {
                        code: iamport_error.code,
                        message: iamport_error.message,
                    },
                };
                logger.error(error);
                error.success = false;
                res.send(error);
            });
    }

    /**
     * Removes a given payment method ('customer_uid') from I'mport for the business ('business_id').
     * @param {*} req 
     * @param {*} res 
     */
    deletePaymentMethod(req, res) {
        const params = { customer_uid: req.body.customer_uid };
        this.iamport.subscribe_customer.delete(params)
            .then((iamport_result) => {
                const msg = `Payment method (${iamport_result.customer_uid}) has been removed.`;
                logger.debug(msg);
                mongoDB.getDB().collection('payment-methods').deleteOne({ customer_uid: iamport_result.customer_uid });
                res.send({
                    success: true,
                    message: msg,
                    data: iamport_result,
                });
            }).catch((iamport_error) => {
                const error = {
                    message: 'Something went wrong with I\'mport while removing the payment method.',
                    params: params,
                    error: {
                        code: iamport_error.code,
                        message: iamport_error.message,
                    },
                };
                logger.error(error);
                error.success = false;
                res.send(error);
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
                business_id: req.params.business_id,
                default_method: true,
            },
            { $set: { default_method: false } },
            // Set the provided method as the new default
            (unset_db_error, unset_write_result) => {
                mongoDB.getDB().collection('payment-methods').updateOne(
                    { customer_uid: req.params.customer_uid },
                    { $set: { default_method: true } },
                    (set_db_error, set_write_result) => {
                        // If no payment method found, return error
                        if (set_write_result.matchedCount === 0) {
                            const msg = `No payment method was found for the given 'customer_uid' (${req.params.customer_uid}).`;
                            logger.error(msg);
                            res.send({
                                success: false,
                                message: msg,
                                error: {
                                    code: 'castr_payment_error',
                                    message: msg,
                                },
                            });
                            return;
                        }
                        // TODO: If successfully set, see if there is any missed payments
                        res.send({
                            success: true,
                            message: `Payment method (${req.params.customer_uid}) has been set as default.`,
                            data: { customer_uid: req.params.customer_uid },
                        });
                    }
                );
            }
        );
    }

    /**
     * Subscribes the business ('business_id') for recurring payments.
     * @param {*} req 
     * @param {*} res 
     */
    subscribe(req, res) {
        // Validate billing plan
        const billing_plan = req.body.billing_plan;
        if (!billing_plan_types.hasOwnProperty(req.body.billing_plan)) {
            const msg = `'billing_plan' not supported, must provide either: ${Object.keys(billing_plan_types)}.`;
            logger.error(msg);
            res.send({
                success: false,
                message: msg,
                error: {
                    code: 'castr_payment_error',
                    message: msg,
                },
            });
            return;
        }
        const business_id = req.params.business_id;
        const charge_num = req.body.charge_num || 0;
        const merchant_uid = `${business_id}_ch${charge_num}`;
        const subscription_params = {
            business_id: business_id,
            merchant_uid: merchant_uid,
            type: 'INITIAL',
            billing_plan: billing_plan,
            pay_date: moment().toDate(),
            amount: req.body.amount,
            vat: req.body.vat,
        };
        // Process initial payment
        this.pay(subscription_params)
            .then((result) => {
                const msg = `Initial payment requested (${merchant_uid}: ${result.data.amount} ${result.data.currency})`;
                logger.debug(msg);
                res.send({
                    success: true,
                    message: msg,
                    data: result.data,
                });
            })
            .catch((error) => {
                error.message = `Initial payment request failed (${merchant_uid}: ${error.params.amount})`;
                logger.error(error);
                error.success = false;
                res.send(error);
            });
    }

    /**
     * Processes a one-time payment using the default payment method set for the business (payment_params.business_id).
     * 
     * Returns a promise.
     * @param {*} payment_params
     */
    pay(payment_params) {
        return new Promise(((resolve, reject) => {
            // Fetch the default payment method
            mongoDB.getDB().collection('payment-methods').findOne(
                {
                    business_id: payment_params.business_id,
                    default_method: true,
                },
                (db_error, default_method) => {
                    // If no default method was found, return error
                    if (default_method === null) {
                        const error = {
                            params: payment_params,
                            error: {
                                code: 'castr_payment_error',
                                message: `Could not find a default payment method for the business (${payment_params.business_id}).`,
                            },
                        };
                        reject(error);
                    }
                    const start = moment(payment_params.pay_date).tz(timezone);
                    const end = moment(start).add(billing_plan_types[payment_params.billing_plan], 'week').subtract(1, 'day');
                    const params = {
                        merchant_uid: payment_params.merchant_uid,
                        customer_uid: default_method.customer_uid,
                        name: `${payment_params.business_id}|Castr(${billing_plan_types[payment_params.billing_plan]})|${start.format('M/D')}-${end.format('M/D')}`,
                        amount: payment_params.amount,
                        cancel_amount: 0,
                        vat: payment_params.vat,
                        custom_data: JSON.stringify({
                            business_id: payment_params.business_id,
                            customer_uid: default_method.customer_uid,
                            type: payment_params.type,
                            billing_plan: payment_params.billing_plan,
                            pay_date: payment_params.pay_date,
                            vat: payment_params.vat,
                        }),
                    };
                    // Request I'mport for payment
                    this.iamport.subscribe.again(params)
                        .then((iamport_result) => {
                            resolve({ data: iamport_result });
                        })
                        .catch((iamport_error) => {
                            params.custom_data = JSON.parse(params.custom_data);
                            const error = {
                                params: params,
                                error: {
                                    code: iamport_error.code,
                                    message: iamport_error.message,
                                },
                            };
                            reject(error);
                        });
                }
            );
        }));
    }

    pause(req, res) {
        logger.debug('pause invoked.');
    }

    resume(req, res) {
        logger.debug('resume invoked.');
    }

    cancel(req, res) {
        logger.debug('cancel invoked.');
    }

    /**
     * Fetches all payment transactions from the business ('business_id').
     * @param {*} req 
     * @param {*} res 
     */
    getHistory(req, res) {
        // Find all payment transactions from the business
        mongoDB.getDB().collection('payment-transactions').find(
            { business_id: req.params.business_id },
            (db_error, cursor) => {
                const methods = [];
                cursor.forEach(
                    // Iteration callback
                    (document) => {
                        document.pay_date_kr = moment(document.pay_date).tz(timezone).format('LL');
                        document.time_paid_kr = moment(document.time_paid).tz(timezone).format('LL');
                        methods.push(document);
                    },
                    // End callback
                    (end) => {
                        const msg = `Transaction history fetched for business (${req.params.business_id})`;
                        logger.debug(msg);
                        res.send({
                            sucecss: true,
                            message: msg,
                            data: methods,
                        });
                    }
                );
            }
        );
    }

    paymentHook(req) {
        switch (req.body.status) {
            case 'ready': {
                // This shouldn't happen, will it?
                // Send email just in case!
                const email = {
                    from: process.env.FROM_EMAIL_ID,
                    to: process.env.TO_EMAIL_IDS,
                    subject: 'Payment Ready',
                    text: JSON.stringify(req.body),
                };
                nodemailer.sendMail(email)
                    .then(info => logger.debug(`Email sent: ${info.response}`))
                    .catch(mail_error => logger.error(mail_error));
                break;
            }
            case 'paid': {
                logger.debug(`Payment request approved & processed (${req.body.merchant_uid})`);
                // Fetch the transaction
                const params = { imp_uid: req.body.imp_uid };
                this.iamport.payment.getByImpUid(params)
                    .then((iamport_result) => {
                        const custom_data = JSON.parse(iamport_result.custom_data);
                        const pay_date = custom_data.pay_date;

                        if (iamport_result.custom_data.type === 'SCHEDULED') {
                            // If payment was a scheduled payment, update the scheduled payments status to PROCESSED
                            mongoDB.getDB().collection('payment-schedule').updateOne(
                                { merchant_uid: iamport_result.merchant_uid },
                                { $set: { status: 'PAID' } },
                                (db_error, write_result) => {
                                    if (db_error) { logger.error(db_error); }
                                }
                            );
                        } else if (iamport_result.custom_data.type === 'INITIAL') {
                            // TODO: Enable castr service
                        }

                        // Insert payment result to db
                        mongoDB.getDB().collection('payment-transactions').insertOne({
                            business_id: custom_data.business_id,
                            imp_uid: iamport_result.imp_uid,
                            merchant_uid: iamport_result.merchant_uid,
                            type: custom_data.type,
                            name: iamport_result.name,
                            currency: iamport_result.currency,
                            amount: iamport_result.amount,
                            vat: custom_data.vat,
                            customer_uid: custom_data.customer_uid,
                            pay_method: iamport_result.pay_method,
                            card_name: iamport_result.card_name,
                            status: 'PAID',
                            receipt_url: iamport_result.receipt_url,
                            pay_date: pay_date,
                            time_paid: moment(iamport_result.paid_at * 1000).toDate(),
                        });

                        // Calculate next pay date
                        const next_pay_date = moment(pay_date).tz(timezone)
                            .add(billing_plan_types[custom_data.billing_plan], 'week')
                            .hour(0)
                            .minute(0)
                            .second(0)
                            .millisecond(0);
                        // Insert to payment-schedule collection
                        const next_charge_num = parseInt(iamport_result.merchant_uid.match(/\d+$/)[0]) + 1;
                        mongoDB.getDB().collection('payment-schedule').insertOne({
                            merchant_uid: `${custom_data.business_id}_ch${next_charge_num}`,
                            business_id: custom_data.business_id,
                            schedule: next_pay_date.toDate(),
                            amount: iamport_result.amount,
                            vat: custom_data.vat,
                            billing_plan: custom_data.billing_plan,
                            status: 'PENDING',
                        });
                    })
                    .catch((iamport_error) => {
                        const error = {
                            message: 'Look up by \'imp_uid\' failed.',
                            params: params,
                            error: {
                                code: iamport_error.code,
                                message: iamport_error.message,
                            },
                        };
                        logger.error(error);
                    });
                break;
            }
            case 'failed': {
                logger.error(`Payment request rejected (${req.body.merchant_uid})`);
                // Fetch the transaction
                const params = { imp_uid: req.body.imp_uid };
                this.iamport.payment.getByImpUid(params)
                    .then((iamport_result) => {
                        const custom_data = JSON.parse(iamport_result.custom_data);
                        const pay_date = custom_data.pay_date;

                        // If payment was a scheduled payment, update the scheduled payments status to FAILED
                        if (iamport_result.custom_data.type === 'SCHEDULED') {
                            const failure = {
                                imp_uid: iamport_result.imp_uid,
                                reason: iamport_result.fail_reason,
                                time_failed: moment(iamport_result.failed_at * 1000).toDate(),
                            };
                            mongoDB.getDB().collection('payment-schedule').updateOne(
                                { merchant_uid: iamport_result.merchant_uid },
                                {
                                    $set: { status: 'FAILED' },
                                    $push: {
                                        failures: {
                                            $each: [failure],
                                            $sort: { time_failed: -1 },
                                        },
                                    },
                                },
                                (db_error, write_result) => {
                                    if (db_error) { logger.error(db_error); }
                                }
                            );
                        }
                    })
                    .catch((iamport_error) => {
                        const error = {
                            message: 'Look up by \'imp_uid\' failed.',
                            params: params,
                            error: {
                                code: iamport_error.code,
                                message: iamport_error.message,
                            },
                        };
                        logger.error(error);
                    });
                // TODO: Disable castr service until new payment method is provided
                break;
            }
            case 'cancelled': {
                // TODO: Update database as refunded
                break;
            }
            default: {
                logger.debug(req.body);
            }
        }
    }
}

module.exports = new IamportService();
