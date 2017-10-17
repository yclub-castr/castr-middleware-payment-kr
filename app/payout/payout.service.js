// app/iamport/iamport.service.js

'use strict';

const mongoDB = require('../db');
const logger = require('../utils').logger();
const moment = require('../utils').moment();
// const crypto2 = require('crypto2');
// const shortid = require('shortid');

const timezone = {
    kr: 'ASIA/SEOUL',
    utc: 'UTC',
};

const full_day = 24 * 60 * 60 * 1000;
const week = full_day * 7;

class PayoutService {
    /**
     * Payout service class constructor.
     */
    constructor() {
        return null;
    }

    initialize() {
        this._checkEvery2Weeks();
        logger.debug('Payout schedule checking initialized.');
    }

    _checkEvery2Weeks() {
        const epoch = moment.unix(0);
        const utc_now = moment.tz(timezone.utc);
        const diff = utc_now.diff(epoch);
        const mod = diff % (2 * week);
        logger.debug(utc_now.day());
        return;
        // const local_next_morning = moment(utc_now).tz(timezone.kr).add(1, 'day').hour(6).minute(0).second(0).millisecond(0);
        // // Calculate time until next 6 am
        // const time_until = local_next_morning.diff(utc_now) % full_day;
        // // Check for scheduled payments at next 6 am
        // const callback = function () {
        //     this._checkScheduledPayments();
        // };
        // setTimeout(callback.bind(this), time_until);
        // logger.debug(`Next schedule check scheduled at ${(time_until / 3600000).toFixed(2)} hours later.`);
    }

    getHistory(req, res) {

    }
}

module.exports = new PayoutService();
