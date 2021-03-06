// app/iamport/iamport.service.js

'use strict';

const mongoDB = require('../db');
const constants = require('../constants');
const logger = require('../utils').logger();
const moment = require('../utils').moment();
// const crypto2 = require('crypto2');
// const shortid = require('shortid');

const timezone = constants.timezone;
const payment_type = constants.payment_type;
const status_type = constants.status_type;
const week = constants.week;

class PayoutService {
    /**
     * Payout service class constructor.
     */
    constructor() {
        return null;
    }

    initialize() {
        this._checkEverySecondFriday();
        logger.debug('Payout schedule checking initialized.');
    }

    _checkEverySecondFriday() {
        const epoch = moment.unix(0);
        const utcNow = moment.tz(timezone.utc);
        const timeSinceEpoch = utcNow.diff(epoch);
        const mod2Weeks = timeSinceEpoch % (2 * week);
        const localNextFriday = moment.tz(timezone.kr).day(5).hour(0).minute(0).second(0).millisecond(0);
        let timeUntilPayout = localNextFriday.diff(utcNow);
        if (mod2Weeks < week) {
            // If on the first week of biweekly schedule, add another week
            timeUntilPayout += week;
        }
        const callback = function () {
            this._payOut();
        };
        setTimeout(callback.bind(this), timeUntilPayout);
        logger.debug(`Next payout scheduled on ${localNextFriday.format('LLLL')}.`);
    }

    /**
     * Inserts to 'mc-statements' using data from 'mc-transactions'
     */
    _payOut() {
        const today = moment.tz(timezone.kr).day(5).hour(0).minute(0).second(0).millisecond(0);
        const twoWeeksAgo = moment(today).subtract(2, 'week');
        mongoDB.getDB().collection('mc-transactions').aggregate(
            [
                {
                    $match: {
                        $and: [
                            { time_created: { $gte: twoWeeksAgo.toDate() } },
                            { time_created: { $lt: today.toDate() } }
                        ],
                    },
                },
                {
                    $group: {
                        _id: '$business_id',
                        raw_sales: { $sum: { $cond: { if: { $eq: ['$type', payment_type.mc_purchase] }, then: '$amount', else: 0 } } },
                        num_voucher_purchases: { $sum: { $cond: { if: { $eq: ['$type', payment_type.mc_purchase] }, then: 1, else: 0 } } },
                        num_coupon_redeems: { $sum: { $cond: { if: { $eq: ['$type', payment_type.mc_redeem] }, then: 1, else: 0 } } },
                    },
                }
            ],
            (db_error, statements) => {
                if (statements.length === 0) { return; }
                logger.debug('Paying out...');
                statements.forEach((statement) => {
                    statement.business_id = statement._id;
                    statement.date_range = {
                        start: twoWeeksAgo.toDate(),
                        end: today.toDate(),
                    };
                    const redeem_svc_fee = statement.num_coupon_redeems * constants.redeem_fee;
                    const purchase_svc_fee = statement.num_voucher_purchases * constants.purchase_fee;
                    statement.payout_amount = statement.raw_sales - redeem_svc_fee - purchase_svc_fee;
                    statement.time_created = new Date();
                    delete statement._id;
                });
                mongoDB.getDB().collection('mc-statements').insertMany(statements)
                    .then(() => {
                        const msg = `Paid out to ${statements.length} businesses.`;
                        logger.debug(msg);
                    })
                    .catch((err) => {
                        logger.error(err.message);
                    });
            }
        );
        // TODO: Integrate with Open-Platform for actual payout.
        this._checkEverySecondFriday();
    }

    getStatements(req, res) {
        const business_id = req.params.business_id;
        mongoDB.getDB().collection('mc-statements').find(
            { business_id: business_id },
            (db_error, cursor) => {
                if (db_error) {
                    res.send({
                        success: false,
                        message: db_error.message,
                    });
                    return;
                }
                const statements = [];
                cursor.sort({ time_created: -1 }).forEach(
                    // Iteration callback
                    (statement) => {
                        statement.date_range.start = moment(statement.date_range.start).tz(timezone.kr).locale('kr').format('LL');
                        statement.date_range.end = moment(statement.date_range.end).tz(timezone.kr).locale('kr').format('LL');
                        statements.push(statement);
                    },
                    // End callback
                    (end) => {
                        const msg = `Payout statements fetched for business (${business_id})`;
                        logger.debug(msg);
                        res.send({
                            sucecss: true,
                            message: msg,
                            data: statements,
                        });
                    }
                );
                // TODO: (FOR UPDATE) Use .limit() & .skip() to implement paging
            }
        );
    }

    getStatementDetails(req, res) {
        const statement_id = req.params.statement_id;
        mongoDB.getDB().collection('mc-statements').findOne({ _id: mongoDB.ObjectId(statement_id) })
            .then((statement) => {
                const business_id = statement.business_id;
                const start_date = statement.date_range.start;
                const end_date = statement.date_range.end;
                mongoDB.getDB().collection('mc-transactions').find(
                    {
                        business_id: business_id,
                        type: payment_type.mc_purchase,
                        status: status_type.paid,
                        $and: [
                            { time_created: { $gte: start_date } },
                            { time_created: { $lt: end_date } }
                        ],
                    },
                    (db_error, cursor) => {
                        const purchases = [];
                        cursor.sort({ time_created: -1 }).forEach(
                            // Iteration callback
                            (document) => {
                                const transaction = {
                                    date: moment(document.time_created).tz(timezone.kr).locale('kr').format('LL'),
                                    description: document.promotable_name,
                                    amount: document.amount,
                                    type: document.type,
                                    status: document.status,
                                };
                                purchases.push(transaction);
                            },
                            // End callback
                            (end) => {
                                const msg = `[#${business_id}] Menucast purchases for date_range ${moment(start_date).tz(timezone.kr).format('L')} - ${moment(end_date).tz(timezone.kr).format('L')}`;
                                logger.debug(msg);
                                res.send({
                                    sucecss: true,
                                    message: msg,
                                    data: {
                                        raw_sales: statement.raw_sales,
                                        num_coupon_redeems: statement.num_coupon_redeems,
                                        num_voucher_purchases: statement.num_voucher_purchases,
                                        payout_amount: statement.payout_amount,
                                        purchases: purchases,
                                    },
                                });
                            }
                        );
                        // TODO: (FOR UPDATE) Use .limit() & .skip() to implement paging
                    }
                );
            })
            .catch((err) => {
                logger.error(err.message);
                res.send({
                    success: false,
                    message: err.message,
                });
            });
    }
}

module.exports = new PayoutService();
