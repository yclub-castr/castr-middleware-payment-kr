// app/iamport/iamport.service.js

'use strict';

const mongoDB = require('../db');
const constants = require('../constants');
const logger = require('../utils').logger();
const moment = require('../utils').moment();
const NodeRSA = require('node-rsa');
const shortid = require('shortid');
const Iamport = require('iamport');

const timezone = constants.timezone;
const billing_plan_type = constants.billing_plan_type;
const payment_type = constants.payment_type;
const status_type = constants.status_type;
const full_day = constants.full_day;
const refund_fee_perc = constants.refund_fee_perc;

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

    initialize() {
        this._checkScheduleAt6AM();
        logger.debug('Payment schedule checking initialized.');
    }

    /**
     * Triggers checking payment schedules at 6 am everyday (local time).
     */
    _checkScheduleAt6AM() {
        const utc_now = moment.tz(timezone.utc);
        const local_next_morning = moment(utc_now).tz(timezone.kr).add(1, 'day').hour(6).minute(0).second(0).millisecond(0);
        // Calculate time until next 6 am
        const time_until = local_next_morning.diff(utc_now) % full_day;
        // Check for scheduled payments at next 6 am
        const callback = function () {
            this._checkScheduledPayments();
        };
        setTimeout(callback.bind(this), time_until);
        logger.debug(`Next pay-schedule checking scheduled at ${(time_until / 3600000).toFixed(2)} hours later.`);
    }

    /**
     * Checks the payment schedules and process them.
     * This runs daily at 6 am (local time).
     */
    _checkScheduledPayments() {
        logger.debug(`Checking for payments scheduled on ${moment.tz(timezone.kr).format('LL')}.`);
        // Result arrays
        const promises = [];
        const successes = [];
        const failures = [];
        // Find all scheduled payments with SCHEDULED status for today and before
        mongoDB.getDB().collection('payment-schedule').find(
            {
                status: status_type.scheduled,
                schedule: { $lte: moment.tz(timezone.kr).hour(0).minute(0).second(0).millisecond(0).toDate() },
            },
            (db_error, cursor) => {
                cursor.forEach(
                    // Iteration callback
                    (document) => {
                        const schedule_params = {
                            business_id: document.business_id,
                            merchant_uid: document.merchant_uid,
                            type: payment_type.scheduled,
                            billing_plan: document.billing_plan,
                            pay_date: new Date(),
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
                                logger.debug(`(${successes.length}/${promises.length}) scheduled payment requests approved:${successes}`);
                                if (failures.length !== 0) {
                                    logger.error(`(${failures.length}/${promises.length}) scheduled payment requests failed:${failures}`);
                                }
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
        this._checkScheduleAt6AM();
    }

    /**
     * Retrieve business plan information.
     * @param {*} req 
     * @param {*} res 
     */
    getPlan(req, res) {
        mongoDB.getDB().collection('payment-schedule').find(
            { business_id: req.params.business_id },
            (db_error, cursor) => {
                if (db_error) {
                    logger.error(`${db_error}`);
                    return;
                }
                const response = {
                    success: true,
                    message: null,
                    data: {
                        plan: null,
                        plan_status: null,
                        billing_date: null,
                        billing_amount: null,
                        next_plan: null,
                        next_plan_status: null,
                        next_billing_date: null,
                        next_billing_amount: null,
                    },
                };
                cursor.sort({ time_scheduled: -1 }).limit(2).next()
                    // Fetch latest schedule
                    .then((last_scheduled) => {
                        // If never subscribed, abort
                        if (!last_scheduled) {
                            response.message = 'No subcription data found for the business.';
                            res.send(response);
                            return null;
                        }
                        // This shouldn't happen, abort
                        if (!cursor.hasNext()) { throw Error('Found a schedule but missing any payment.'); }
                        const last_status = last_scheduled.status;
                        // If no schedule but only paid schedules
                        if (last_status === status_type.paid) {
                            response.message = 'Subscription not active for the business.';
                            res.send(response);
                            return null;
                        }
                        // If last payment failed
                        if (last_status === status_type.failed) {
                            response.message = 'Subscription not active for the business.';
                            response.data.plan_status = last_status;
                            response.data.fail_reason = last_scheduled.failures[last_scheduled.failures.length - 1].reason;
                            response.data.plan = last_scheduled.billing_plan;
                            response.data.billing_date = last_scheduled.schedule;
                            response.data.billing_amount = last_scheduled.amount;
                            res.send(response);
                            return null;
                        }
                        // If last payment already refunded
                        if (last_status === status_type.unscheduled) {
                            response.message = 'Subscription not active for the business.';
                        }
                        // Include next plan details
                        response.data.next_plan_status = last_status;
                        response.data.next_plan = last_scheduled.billing_plan;
                        response.data.next_billing_date = last_scheduled.schedule;
                        response.data.next_billing_amount = last_scheduled.amount;
                        return cursor.next();
                    })
                    .then((last_paid) => {
                        // Handle inactive subscription
                        if (!last_paid) { return; }
                        // This shouldn't happen, abort
                        if (![status_type.paid, status_type.cancelled].includes(last_paid.status)) { throw Error('[POSSIBLE DUPLICATE SCHEDULE] Second to last schedule obj was not processed.'); }
                        // Include current plan details and respond
                        response.data.plan_status = last_paid.status;
                        response.data.plan = last_paid.billing_plan;
                        response.data.billing_date = last_paid.schedule;
                        response.data.billing_amount = last_paid.amount;
                        res.send(response);
                    })
                    .catch((err) => {
                        res.send({
                            success: false,
                            message: err.message,
                        });
                    });
            }
        );
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
    savePaymentMethod(req, res) {
        const business_id = req.params.business_id;
        let customer_uid;
        let is_default;
        this._rsaDecryptArray(req.body.payload)
            .then((payload) => {
                const body = JSON.parse(payload);
                const card_number = body.card_number;
                const last_4_digits = card_number.split('-')[3];
                customer_uid = `${business_id}_${last_4_digits}`;
                is_default = body.is_default;
                // Check for I'mport vulnerability
                if (last_4_digits.length !== 4) { throw new Error(`The last 4 digits are not 4 digits long (${last_4_digits}).`); }
                // Request I'mport service
                return this.iamport.subscribe_customer.create({
                    // Required
                    customer_uid: customer_uid,
                    card_number: card_number,
                    pwd_2digit: body.pwd_2digit,
                    expiry: body.exp,
                    birth: body.dob,
                    // Optional
                    customer_name: body.name,
                    customer_tel: body.phone,
                    customer_email: body.email,
                    customer_addr: body.address,
                    customer_postcode: body.zip,
                });
            })
            // Update this payment method to the business account in castrDB
            .then(iamport_result => mongoDB.getDB().collection('payment-methods').updateOne(
                { customer_uid: iamport_result.customer_uid },
                {
                    $setOnInsert: {
                        business_id: business_id,
                        customer_uid: iamport_result.customer_uid,
                        time_created: new Date(),
                    },
                    $set: {
                        default_method: is_default,
                        time_updated: new Date(),
                    },
                },
                { upsert: true }
            ))
            .then((write_result) => {
                const msg = `Payment method (${customer_uid}) has been saved to DB.`;
                logger.debug(msg);
                res.send({
                    success: true,
                    message: msg,
                    data: {
                        inserted: write_result.upsertedCount,
                        updated: write_result.modifiedCount,
                    },
                });
            })
            .catch((err) => {
                const error = {
                    success: false,
                    message: 'Something went wrong while registering payment method.',
                    params: {
                        business_id: business_id,
                        customer_uid: customer_uid,
                        is_default: req.body.is_default,
                    },
                    error: {
                        code: err.code,
                        message: err.message,
                    },
                };
                logger.error(error);
                res.send(error);
            });
    }

    /**
     * Removes a given payment method ('customer_uid') from I'mport for the business ('business_id').
     * @param {*} req 
     * @param {*} res 
     */
    deletePaymentMethod(req, res) {
        const business_id = req.params.business_id;
        const customer_uid = req.body.customer_uid;
        // Validate business_id & customer_uid consistency
        const regex = new RegExp(`${business_id}_\\d+$`, 'g');
        if (!customer_uid.match(regex)) {
            res.send({
                success: false,
                message: `Invalid payment method (#${customer_uid}) for business (#${business_id})`,
            });
            return;
        }
        const params = { customer_uid: customer_uid };
        this.iamport.subscribe_customer.delete(params)
            .then((iamport_result) => {
                const msg = `Payment method (${iamport_result.customer_uid}) removed from I'mport`;
                logger.debug(msg);
                return mongoDB.getDB().collection('payment-methods').deleteOne({ customer_uid: iamport_result.customer_uid });
            })
            .then((db_delete_result) => {
                const msg = `Payment method (${customer_uid}) removed from DB`;
                logger.debug(msg);
                res.send({
                    success: true,
                    message: msg,
                    data: { deleted: db_delete_result.deletedCount },
                });
            })
            .catch((iamport_error) => {
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
        const business_id = req.params.business_id;
        const customer_uid = req.params.customer_uid;
        // Unset the current default method   
        mongoDB.getDB().collection('payment-methods').updateOne(
            {
                business_id: business_id,
                default_method: true,
            },
            { $set: { default_method: false } },
            // Set the provided method as the new default
            (unset_db_error, unset_write_result) => {
                mongoDB.getDB().collection('payment-methods').updateOne(
                    { customer_uid: customer_uid },
                    { $set: { default_method: true } },
                    (set_db_error, set_write_result) => {
                        // If no payment method found, return error
                        if (set_write_result.matchedCount === 0) {
                            const msg = `No payment method was found for the given 'customer_uid' (${customer_uid}).`;
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
                        logger.debug(`Business (${business_id}): default pay_method changed to ${customer_uid}`);
                        // See if there is any failed scheduled payments
                        mongoDB.getDB().collection('payment-schedule').findOne(
                            {
                                business_id: business_id,
                                status: status_type.failed,
                            },
                            (db_error, failed_payment) => {
                                if (!failed_payment) { return; }
                                if (db_error) { logger.error(db_error); }
                                const schedule_params = {
                                    business_id: failed_payment.business_id,
                                    merchant_uid: failed_payment.merchant_uid,
                                    type: payment_type.scheduled,
                                    billing_plan: failed_payment.billing_plan,
                                    pay_date: moment().toDate(),
                                    amount: failed_payment.amount,
                                    vat: failed_payment.vat,
                                };
                                // Make the payment
                                logger.debug(`[ATTEMPT ${(failed_payment.failures.length + 1)}] Requesting failed scheduled payment (${schedule_params.merchant_uid})`);
                                this.pay(schedule_params)
                                    .then(() => { })
                                    .catch(() => { });
                            }
                        );
                        res.send({
                            success: true,
                            message: `Payment method (${customer_uid}) has been set as default.`,
                            data: null,
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
        if (!billing_plan_type.hasOwnProperty(req.body.billing_plan)) {
            const msg = `'billing_plan' not supported, must provide either: ${Object.keys(billing_plan_type)}.`;
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
        mongoDB.getDB().collection('payment-schedule').find(
            { business_id: business_id },
            (db_error, cursor) => {
                let merchant_uid;
                cursor.sort({ time_scheduled: -1 }).limit(1).next()
                    // Fetch latest schedule
                    .then((last_scheduled) => {
                        if (last_scheduled.status === status_type.scheduled) {
                            const msg = `Business (#${business_id}) already subscribed`;
                            res.send({
                                success: false,
                                message: msg,
                                error: {
                                    code: 'castr_payment_error',
                                    message: msg,
                                },
                            });
                            return null;
                        }
                        let charge_num = 0;
                        if (req.body.charge_num) {
                            charge_num = req.body.charge_num;
                        } else if (last_scheduled) {
                            charge_num = parseInt(last_scheduled.merchant_uid.match(/\d+$/)[0]) + 1;
                        }
                        merchant_uid = `${business_id}_ch${charge_num}`;
                        const subscription_params = {
                            business_id: business_id,
                            merchant_uid: merchant_uid,
                            type: payment_type.initial,
                            billing_plan: billing_plan,
                            pay_date: moment().toDate(),
                            amount: req.body.amount,
                            vat: req.body.vat,
                        };
                        // Process initial payment
                        return this.pay(subscription_params);
                    })
                    .then((result) => {
                        if (result) {
                            const msg = `Initial payment sccuessful (${merchant_uid})`;
                            logger.debug(`Enabling Castr service for business (${business_id})`);
                            res.send({
                                success: true,
                                message: msg,
                                data: result.data,
                            });
                        }
                    })
                    .catch((error) => {
                        logger.error(error.message);
                        res.send({
                            success: false,
                            message: `Initial payment failed (${merchant_uid})`,
                            error: {
                                code: error.code || 'castr_payment_error',
                                message: error.message,
                            },
                        });
                    });
            }
        );
    }

    changeSubscription(req, res) {
        const business_id = req.params.business_id;
        const new_billing_plan = req.body.billing_plan;
        const new_amount = req.body.amount;
        let old_billing_plan;
        let old_amount;
        let schedule;
        mongoDB.getDB().collection('payment-schedule').findOne({
            business_id: req.params.business_id,
            status: { $in: [status_type.scheduled, status_type.failed, status_type.paused] },
        })
            .then((scheduled_payment) => {
                if (!scheduled_payment) {
                    throw Error(`Business (${business_id}) is either invalid, not yet subscribed, or is missing next payment schedule`);
                }
                old_billing_plan = scheduled_payment.billing_plan;
                old_amount = scheduled_payment.amount;
                schedule = scheduled_payment.schedule;
                return mongoDB.getDB().collection('payment-schedule').updateOne(
                    { merchant_uid: scheduled_payment.merchant_uid },
                    {
                        $set: {
                            billing_plan: new_billing_plan,
                            amount: new_amount,
                            time_scheduled: new Date(),
                        },
                    }
                );
            })
            .then((update_result) => {
                const msg = `Business (${business_id}): Subscription change ${old_billing_plan}(${old_amount}) => ${new_billing_plan}(${new_amount})`;
                logger.debug(msg);
                res.send({
                    success: true,
                    message: msg,
                    data: {
                        business_id: business_id,
                        schedule: schedule,
                        old_billing_plan: old_billing_plan,
                        new_billing_plan: new_billing_plan,
                    },
                });
            })
            .catch((error) => {
                logger.error(error.message);
                res.send({
                    success: false,
                    message: error.message,
                    error: error,
                });
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
                        return;
                    }
                    const name = this._generateName(payment_params);
                    const params = {
                        merchant_uid: payment_params.merchant_uid,
                        customer_uid: default_method.customer_uid,
                        name: name.short,
                        amount: payment_params.amount,
                        vat: payment_params.vat,
                        custom_data: JSON.stringify({
                            business_id: payment_params.business_id,
                            merchant_uid: payment_params.merchant_uid,
                            customer_uid: default_method.customer_uid,
                            name: name,
                            type: payment_params.type,
                            billing_plan: payment_params.billing_plan,
                            pay_date: payment_params.pay_date,
                            amount: payment_params.amount,
                            vat: payment_params.vat,
                        }),
                    };
                    // Request I'mport for payment
                    this.iamport.subscribe.again(params)
                        .then((iamport_result) => {
                            setTimeout(this.paymentHook, 0, iamport_result);
                            if (status_type[iamport_result.status] === status_type.failed) {
                                const error = {
                                    params: JSON.parse(params.custom_data),
                                    error: {
                                        code: null,
                                        message: iamport_result.fail_reason,
                                    },
                                };
                                reject(error);
                                return;
                            }
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

    /**
     * Sets the next occuring schedule's status to PAUSED 
     * @param {*} req 
     * @param {*} res 
     */
    pause(req, res) {
        mongoDB.getDB().collection('payment-schedule').findOneAndUpdate(
            {
                business_id: req.params.business_id,
                status: status_type.scheduled,
            },
            { $set: { status: status_type.paused } },
            { sort: { time_scheduled: -1 } }
        )
            .then(() => {
                const msg = `Paused the next schedule for business (#${req.params.business_id})`;
                logger.debug(msg);
                res.send({
                    success: true,
                    message: msg,
                });
            })
            .catch((db_error) => {
                logger.error(db_error.message);
                res.send({
                    success: false,
                    message: db_error.message,
                });
            });
    }

    /**
     * 
     * @param {*} req 
     * @param {*} res 
     */
    resume(req, res) {
        const business_id = req.params.business_id;
        mongoDB.getDB().collection('payment-schedule').findOne({
            business_id: business_id,
            status: status_type.paused,
        })
            .then((paused_schedule) => {
                const update = { status: status_type.scheduled };
                const schedule_id = paused_schedule.merchant_uid;
                const schedule_date = moment(paused_schedule.schedule);
                const now = moment();
                if (schedule_date.diff(now) < 0) {
                    // Handle expired schedule
                    update.schedule = new Date();
                    update.time_scheduled = new Date();
                    logger.debug(`Next schedule (#${schedule_id}) was EXPIRED (${schedule_date.format('LL')})`);
                    return mongoDB.getDB().collection('payment-schedule').findOneAndUpdate(
                        { merchant_uid: schedule_id },
                        { $set: update }
                    );
                }
                return mongoDB.getDB().collection('payment-schedule').updateOne({ merchant_uid: schedule_id }, { $set: update });
            })
            .then((promise_result) => {
                if (!promise_result.value) { return null; }
                logger.debug(`Resubscribing business (#${business_id}) with expired schedule data...`);
                const document = promise_result.value;
                const schedule_params = {
                    business_id: document.business_id,
                    merchant_uid: document.merchant_uid,
                    type: payment_type.scheduled,
                    billing_plan: document.billing_plan,
                    pay_date: new Date(),
                    amount: document.amount,
                    vat: document.vat,
                };
                return this.pay(schedule_params);
            })
            .then((result) => {
                const msg = `Resumed the next schedule for business (#${business_id})`;
                if (result) { logger.debug(`Resubscribing payment sccuessful (${result.data.merchant_uid})`); }
                logger.debug(msg);
                res.send({
                    success: true,
                    message: msg,
                });
            })
            .catch((err) => {
                logger.error(err.message);
                res.send({
                    success: false,
                    message: err.message,
                });
            });
    }

    refund(req, res) {
        const business_id = req.params.business_id;
        let schedule_id;
        // Fetch the last paid subscription object (PAID)
        mongoDB.getDB().collection('payment-schedule').find(
            { business_id: business_id },
            (db_error, cursor) => {
                if (db_error) {
                    logger.error(db_error);
                    return;
                }
                cursor.sort({ time_scheduled: -1 }).limit(2).next()
                    // Fetch latest schedule
                    .then((last_scheduled) => {
                        // If never subscribed, abort
                        if (last_scheduled === null) { throw Error('No subcription data found for the business.'); }
                        const last_status = last_scheduled.status;
                        // If last payment failed or already refunded, abort
                        if ([status_type.failed, status_type.unscheduled].includes(last_status)) {
                            throw Error('Nothing to refund for the business.');
                        }
                        // This shouldn't happen, abort
                        if (!cursor.hasNext()) { throw Error('Found a schedule but missing any payment.'); }
                        schedule_id = last_scheduled.merchant_uid;
                        return cursor.next();
                    })
                    // Fetch last payment
                    .then((last_paid) => {
                        // This shouldn't happen, abort
                        if (last_paid.status !== status_type.paid) { throw Error('[POSSIBLE DUPLICATE SCHEDULE] Second to last schedule obj was not processed.'); }
                        // Calculate how much time has passed since the last payment
                        const plan_value = last_paid.amount;
                        const tmr = moment.tz(timezone.kr).add(1, 'day').hour(0).minute(0).second(0).millisecond(0);
                        const date_last_paid = moment(last_paid.schedule).tz(timezone.kr).hour(0).minute(0).second(0).millisecond(0);
                        const plan_time = billing_plan_type[last_paid.billing_plan] * 7 * full_day;
                        const time_served = tmr.diff(date_last_paid);
                        // Calculate prorated refund amount
                        const perc_served = time_served / plan_time;
                        const value_unserved = (1 - perc_served) * plan_value;
                        // If refunding within 24 hours, process full refund. Otherwise, 80% of prorated value
                        const in24hr = time_served <= full_day;
                        const rf_val = (in24hr) ? plan_value : (value_unserved * (1 - refund_fee_perc)).toFixed(0);
                        // Prepare msg
                        const plan_str = `\n - Plan: ${last_paid.billing_plan} (${plan_value})`;
                        const serv_str = `\n - Days served: ${(time_served / full_day).toFixed(0)} (${perc_served.toFixed(2)}%)`;
                        const unserv_str = `\n - Value unserved: ${value_unserved.toFixed(0)}`;
                        const fee_str = `\n - Cancellation fee: -${(value_unserved * refund_fee_perc).toFixed(0)}${(in24hr) ? ' [WAIVED]' : ''}`;
                        const rfval_str = `\n - Refund value: ${rf_val}`;
                        logger.debug(`Refund request from business (#${business_id}):${plan_str}${serv_str}${unserv_str}${fee_str}${rfval_str}`);
                        return {
                            merchant_uid: last_paid.merchant_uid,
                            amount: rf_val,
                        };
                    })
                    .then((refund) => {
                        // Cancel the latest schedule
                        mongoDB.getDB().collection('payment-schedule').updateOne(
                            { merchant_uid: schedule_id },
                            { $set: { status: status_type.unscheduled } },
                            (err, write_result) => {
                                logger.debug(`Cancelled payment schedule (#${schedule_id})`);
                            }
                        );
                        return refund;
                    })
                    .then((refund) => {
                        // Refund the prorated amount
                        const params = {
                            merchant_uid: refund.merchant_uid,
                            amount: refund.amount,
                            reason: req.body.reason || 'Castr user refund request',
                        };
                        return this.iamport.payment.cancel(params);
                    })
                    .then((iamport_result) => {
                        setTimeout(this.paymentHook.bind(this), 0, iamport_result);
                        if (status_type[iamport_result.status] === status_type.failed) {
                            const error = {
                                success: false,
                                message: iamport_result.fail_reason,
                                error: {
                                    code: null,
                                    message: iamport_result.fail_reason,
                                },
                            };
                            res.send(error);
                        }
                        res.send({
                            success: true,
                            message: `Refund for previous payment (#${iamport_result.merchant_uid}) successful.`,
                            data: {
                                refund_amount: iamport_result.cancel_amount,
                                refund_reason: iamport_result.cancel_history.reason,
                            },
                        });
                    })
                    .catch((err) => {
                        const error = {
                            message: err.message,
                            params: { business_id: business_id },
                            error: {
                                code: err.code || 'castr_payment_error',
                                message: err.message,
                            },
                        };
                        logger.error(error);
                        error.success = false;
                        res.send(error);
                    });
            }
        );
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
                cursor.sort({ time_created: -1 }).forEach(
                    // Iteration callback
                    (document) => {
                        document.pay_date = {
                            date: document.pay_date,
                            string: moment(document.pay_date).tz(timezone.kr).format('LL'),
                            string_kr: moment(document.pay_date).locale('kr').tz(timezone.kr).format('LL'),
                        };
                        document.time_paid = {
                            date: document.time_paid,
                            string: moment(document.time_paid).tz(timezone.kr).format('LL'),
                            string_kr: moment(document.time_paid).locale('kr').tz(timezone.kr).format('LL'),
                        };
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
                // TODO: (FOR UPDATE) Use .limit() & .skip() to implement paging
            }
        );
    }

    paymentHook(iamport_result) {
        const status = status_type[iamport_result.status];
        switch (status) {
            case status_type.paid: {
                const custom_data = JSON.parse(iamport_result.custom_data);
                let log_string = `approved & processed (${custom_data.merchant_uid})`;
                // Insert payment result to db
                mongoDB.getDB().collection('payment-transactions').insertOne({
                    business_id: custom_data.business_id,
                    imp_uid: iamport_result.imp_uid,
                    merchant_uid: custom_data.merchant_uid,
                    type: custom_data.type,
                    name: custom_data.name,
                    currency: iamport_result.currency,
                    amount: custom_data.amount,
                    vat: custom_data.vat,
                    customer_uid: custom_data.customer_uid,
                    pay_method: iamport_result.pay_method,
                    card_name: iamport_result.card_name,
                    status: status,
                    receipt_url: iamport_result.receipt_url,
                    pay_date: custom_data.pay_date,
                    time_paid: moment(iamport_result.paid_at * 1000).toDate(),
                    time_created: new Date(),
                })
                    // Update payment-schedule with processed payment
                    .then((tx_insert_result) => {
                        // If payment was a scheduled payment, update the payment's scheduled status to PAID
                        if (custom_data.type === payment_type.scheduled) {
                            log_string = `Scheduled payment ${log_string}`;
                            return mongoDB.getDB().collection('payment-schedule').updateOne(
                                { merchant_uid: custom_data.merchant_uid },
                                {
                                    $set: {
                                        status: status,
                                        time_processed: new Date(),
                                    },
                                }
                            );
                        }
                        // If payment was an initial payment, insert the payment schedule with PAID status
                        if (custom_data.type === payment_type.initial) {
                            log_string = `Initial payment ${log_string}`;
                            return mongoDB.getDB().collection('payment-schedule').insertOne({
                                schedule: moment(custom_data.pay_date).toDate(),
                                business_id: custom_data.business_id,
                                merchant_uid: custom_data.merchant_uid,
                                status: status_type.paid,
                                billing_plan: custom_data.billing_plan,
                                amount: custom_data.amount,
                                vat: custom_data.vat,
                                time_scheduled: new Date(),
                                time_processed: new Date(),
                            });
                        }
                        // Shouldn't happen
                        throw new Error(`Unhandled payment type ${custom_data.type}`);
                    })
                    // Add next schedule
                    .then(() => {
                        logger.debug(log_string);
                        // Calculate next pay date
                        const next_pay_date = moment(custom_data.pay_date).tz(timezone.kr)
                            .add(billing_plan_type[custom_data.billing_plan], 'week')
                            .hour(0)
                            .minute(0)
                            .second(0)
                            .millisecond(0);
                        // Insert next schedule to DB
                        const next_charge_num = parseInt(custom_data.merchant_uid.match(/\d+$/)[0]) + 1;
                        const next_merchant_uid = `${custom_data.business_id}_ch${next_charge_num}`;
                        mongoDB.getDB().collection('payment-schedule').insertOne(
                            {
                                schedule: next_pay_date.toDate(),
                                merchant_uid: next_merchant_uid,
                                business_id: custom_data.business_id,
                                billing_plan: custom_data.billing_plan,
                                amount: custom_data.amount,
                                vat: custom_data.vat,
                                status: status_type.scheduled,
                                time_scheduled: new Date(),
                            },
                            (db_error) => {
                                if (db_error) { logger.error(db_error); }
                                logger.debug(`Next payment (${next_merchant_uid}) scheduled for ${next_pay_date.format('LL')}`);
                            }
                        );
                    })
                    .catch((error) => {
                        logger.error({
                            error: {
                                code: error.code,
                                message: error.message,
                            },
                        });
                    });
                break;
            }
            case status_type.cancelled: {
                const custom_data = JSON.parse(iamport_result.custom_data);
                // Insert payment result to db
                mongoDB.getDB().collection('payment-transactions').insertOne({
                    business_id: custom_data.business_id,
                    imp_uid: iamport_result.imp_uid,
                    merchant_uid: custom_data.merchant_uid,
                    type: custom_data.type,
                    name: this._generateName(custom_data.name, true),
                    currency: iamport_result.currency,
                    amount: -iamport_result.cancel_amount,
                    customer_uid: custom_data.customer_uid,
                    pay_method: iamport_result.pay_method,
                    card_name: iamport_result.card_name,
                    status: status,
                    receipt_url: iamport_result.cancel_history[0].receipt_url,
                    pay_date: custom_data.pay_date,
                    ref_reason: iamport_result.cancel_history[0].reason,
                    time_refunded: moment(iamport_result.cancelled_at * 1000).toDate(),
                    time_created: new Date(),
                })
                    // Update the payment schedule as refunded
                    .then(() => mongoDB.getDB().collection('payment-schedule').updateOne(
                        { merchant_uid: custom_data.merchant_uid },
                        { $set: { status: status } }
                    ))
                    .then(() => { logger.debug(`Refund processed (${custom_data.merchant_uid})`); })
                    .catch((error) => {
                        logger.error({
                            error: {
                                code: error.code,
                                message: error.message,
                            },
                        });
                    });
                break;
            }
            case status_type.failed: {
                const custom_data = JSON.parse(iamport_result.custom_data);
                // If payment was a scheduled payment, update the scheduled payments status to FAILED
                if (custom_data.type === payment_type.scheduled) {
                    const failure = {
                        imp_uid: iamport_result.imp_uid,
                        params: custom_data,
                        reason: iamport_result.fail_reason,
                        time_failed: moment(iamport_result.failed_at * 1000).toDate(),
                    };
                    mongoDB.getDB().collection('payment-schedule').updateOne(
                        { merchant_uid: custom_data.merchant_uid },
                        {
                            $set: { status: status },
                            $push: {
                                failures: {
                                    $each: [failure],
                                    $sort: { time_failed: -1 },
                                },
                            },
                        }
                    )
                        .then(() => {
                            logger.debug(`Scheduled payment (${custom_data.merchant_uid}) rejected`);
                            /*
                             * TODO: Disable castr service until failed payment is resolved 
                             * - Todo: Should implement a webhook to call Castr server to stop service
                             * - Note: Setting a different payment method will retry the failed payment
                             */
                            logger.debug(`Disabling Castr service for business (${custom_data.business_id})`);
                        })
                        .catch((db_error) => {
                            logger.error(db_error);
                        });
                }
                break;
            }
            default: {
                logger.debug(`Default block reached with:\n${iamport_result}`);
            }
        }
    }

    mcPay(req, res) {
        const business_id = req.params.business_id;
        const promotable_id = req.params.promotable_id;
        const mc_customer_id = req.body.mc_customer_id;
        const custom_data = {};
        const user_data = {};
        this._rsaDecryptArray(req.body.payload)
            .then((payload) => {
                const body = JSON.parse(payload);
                custom_data.quantity = body.qty;
                // User payment method
                user_data.card_number = body.card_number;
                user_data.pwd_2digit = body.pwd_2digit;
                user_data.expiry = body.exp;
                user_data.birth = body.dob;
                // User data
                user_data.buyer_name = body.name;
                user_data.buyer_tel = body.phone;
                user_data.buyer_email = body.email;
                user_data.buyer_addr = body.address;
                user_data.buyer_postcode = body.zip;
                return mongoDB.getDB().collection('promotions').findOne({ promoTable: { $elemMatch: { _id: mongoDB.ObjectId(promotable_id) } } });
            })
            .then((promotion) => {
                promotion.promoTable.forEach((promotable) => {
                    if (promotable._id.toString() === promotable_id) {
                        custom_data.promotable_id = promotable_id;
                        custom_data.promotable_name = promotable.nameOne;
                        custom_data.perc_disc_applied = promotable.discount;
                        custom_data.amount = parseInt(promotable.price * (1 - (promotable.discount / 100)));
                    }
                });
                // Custom data for I'mport
                custom_data.business_id = business_id;
                custom_data.mc_customer_id = mc_customer_id;
                custom_data.name = this._generateName({
                    business_id: business_id,
                    promotable_name: custom_data.promotable_name,
                    type: payment_type.mc_purchase,
                });
                custom_data.type = payment_type.mc_purchase;
                return this.iamport.subscribe.onetime({
                    name: custom_data.name.short,
                    merchant_uid: `mc_${shortid.generate()}`,
                    amount: custom_data.amount * custom_data.quantity,
                    card_number: user_data.card_number,
                    pwd_2digit: user_data.pwd_2digit,
                    expiry: user_data.expiry,
                    birth: user_data.birth,
                    buyer_name: user_data.buyer_name,
                    buyer_tel: user_data.buyer_tel,
                    buyer_email: user_data.buyer_email,
                    buyer_addr: user_data.buyer_addr,
                    buyer_postcode: user_data.buyer_postcode,
                    custom_data: JSON.stringify(custom_data),
                });
            })
            // Process response
            .then((iamport_result) => {
                if (status_type[iamport_result.status] === status_type.failed) {
                    res.send({
                        success: false,
                        message: iamport_result.fail_reason,
                        params: JSON.parse(iamport_result.custom_data),
                        error: {
                            code: null,
                            message: iamport_result.fail_reason,
                        },
                    });
                    return;
                }
                res.send({
                    success: true,
                    message: 'Payment successful',
                });
                setTimeout(this.mcPaymentHook, 0, iamport_result);
            })
            .catch((err) => {
                logger.error(err.message);
                const error = {
                    success: false,
                    params: custom_data,
                    error: {
                        code: err.code || 'mc_pay_error',
                        message: err.message,
                    },
                };
                res.send(error);
            });
    }

    mcPaymentHook(mc_iamport_result) {
        // Ditch non-MC notifications
        if (mc_iamport_result.merchant_uid.substring(0, 3) !== 'mc_') { return; }
        const custom_data = JSON.parse(mc_iamport_result.custom_data);
        const status = status_type[mc_iamport_result.status];
        if (status === status_type.paid) {
            const transactions = [];
            for (let i = 0; i < custom_data.quantity; i += 1) {
                transactions.push({
                    business_id: custom_data.business_id,
                    mc_customer_id: custom_data.mc_customer_id,
                    promotable_id: custom_data.promotable_id,
                    promotable_name: custom_data.promotable_name,
                    merchant_uid: mc_iamport_result.merchant_uid,
                    type: custom_data.type,
                    name: custom_data.name,
                    currency: mc_iamport_result.currency,
                    amount: custom_data.amount,
                    perc_disc_applied: custom_data.perc_disc_applied,
                    pay_method: mc_iamport_result.pay_method,
                    card_name: mc_iamport_result.card_name,
                    status: status,
                    receipt_url: mc_iamport_result.receipt_url,
                    time_created: new Date(),
                });
            }
            // Insert payment result to db
            mongoDB.getDB().collection('mc-transactions').insertMany(transactions)
                .then((insert_result) => {
                    logger.debug(`Menucast purchase (${transactions.length} transactions) successfully saved to DB`);
                })
                .catch((err) => {
                    logger.error(err.message);
                });
        }
    }

    /**
     * Generates a name for the payment.
     * @param {*} params 
     * @param {boolean} isRefund 
     */
    _generateName(params, isRefund) {
        if (isRefund) {
            return {
                short: `REF_${params.short}`,
                long: `[REFUND] ${params.long}`,
                long_kr: `[환불] ${params.long_kr}`,
            };
        }
        const business_id = params.business_id.substring(params.business_id.length - 6);
        if (params.type === payment_type.mc_purchase) {
            const promotable_name = params.promotable_name;
            return {
                short: `MC#${business_id}=${promotable_name}`,
                long: `Menucast purchase [#${business_id}] - ${promotable_name}`,
                long_kr: `메뉴캐스트 결제 [#${business_id}] - ${promotable_name}`,
            };
        }
        const billing_plan = params.billing_plan;
        const pay_date = params.pay_date;
        const start = moment(pay_date).tz(timezone.kr);
        const end = moment(start).add(billing_plan_type[billing_plan], 'week').subtract(1, 'day');
        return {
            short: `CAS#${business_id}=${start.format('M/D')}-${end.format('M/D')}(${billing_plan_type[billing_plan]}WK)`,
            long: `Castr subscription #${business_id} ${start.format('M/D')}-${end.format('M/D')} (${billing_plan})`,
            long_kr: `캐스터 정기구독 #${business_id} ${start.format('M/D')}-${end.format('M/D')} (${billing_plan_type[billing_plan]}주)`,
        };
    }

    _rsaDecryptArray(encryption_array) {
        return new Promise(async function (resolve, reject) {
            const decoder = new NodeRSA(process.env.RSA_PRIV_KEY);
            decoder.setOptions({ encryptionScheme: 'pkcs1' });
            let decrypted = '';
            try {
                for (let i = 0; i < encryption_array.length; i += 1) {
                    decrypted += await this._rsaDecrypt(decoder, encryption_array[i]);
                }
                resolve(decrypted);
            } catch (err) {
                reject(err);
            }
        });
    }

    _rsaDecrypt(decoder, encrypted) {
        return new Promise((resolve, reject) => {
            try {
                const decrypted = decoder.decrypt(encrypted, 'utf8');
                resolve(decrypted);
            } catch (err) {
                reject(err);
            }
        });
    }
}

module.exports = new IamportService();
